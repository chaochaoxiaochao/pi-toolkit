import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HerdrAutomation } from "./herdr.ts";
import { parseReport, type PersistedReport, type TaskRecord } from "./records.ts";
import { attemptReportPath, attemptStatePath, createAttemptId } from "./attempts.ts";
import { writeJsonAtomic } from "./state.ts";

export interface LiveTaskRecord {
	id: string;
	name?: string;
	agent?: string;
	sessionFile: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	skills?: string[];
	extensions?: string[];
	currentAttemptId?: string;
}

export const PARENT_PANE_ENV = "PI_HERDR_SUBAGENTS_PARENT_PANE_ID";

export function childEnvironment(taskDirectory: string, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const parentPaneId = environment.HERDR_PANE_ID?.trim();
	return {
		PI_HERDR_SUBAGENTS_CHILD: "1",
		PI_HERDR_SUBAGENTS_TASK_DIR: taskDirectory,
		...(parentPaneId ? { [PARENT_PANE_ENV]: parentPaneId } : {}),
	};
}

export function childPiArgs(task: LiveTaskRecord, systemPromptFile: string): string[] {
	const args = [
		"--approve", "--session", task.sessionFile,
		"--name", `Subagent: ${task.name ?? task.agent ?? "worker"}`,
		"--no-extensions", "--extension", "builtin:codemode",
		"--extension", fileURLToPath(new URL("../extensions/subagent-report.ts", import.meta.url)),
		"--no-skills", "--append-system-prompt", systemPromptFile,
	];
	for (const extension of task.extensions ?? []) args.push("--extension", extension);
	if (task.model) args.push("--model", task.model);
	if (task.thinking) args.push("--thinking", task.thinking);
	if (task.tools?.length) {
		// Pi keeps this allowlist after startup, including editor protocol switches.
		const editorTools = task.tools.includes("edit") ? ["apply_patch"] : [];
		args.push("--tools", [...new Set([...task.tools, ...editorTools, "codemode", "subagent_report"])].join(","));
	} else args.push("--tools", "+codemode");
	for (const skill of task.skills ?? []) args.push("--skill", skill);
	return args;
}

export function liveAgentName(taskId: string, _attempt = 1): string {
	return `herdr-subagent-${taskId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
}

async function pause(signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Subagent wait aborted.")); };
		const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 250);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function promptLiveAgent(options: {
	herdr: HerdrAutomation;
	task: LiveTaskRecord;
	paneId: string;
	prompt: string;
	systemPromptFile: string;
	agentName?: string;
	attempt?: number;
	signal?: AbortSignal;
	start?: boolean;
	stalledWarningMs?: number;
	onStalled?: () => void;
	onRuntimeUpdate?: (task: TaskRecord) => void | Promise<void>;
	attemptId?: string;
}): Promise<{ report: PersistedReport; agentName: string; attemptId: string }> {
	const taskDirectory = dirname(options.task.sessionFile);
	const reportFile = join(taskDirectory, "report.json");
	const taskFile = join(taskDirectory, "task.json");
	const attemptId = options.attemptId ?? createAttemptId();
	const attemptReportFile = attemptReportPath(taskDirectory, attemptId);
	await Promise.all([
		mkdir(dirname(attemptReportFile), { recursive: true, mode: 0o700 }),
		mkdir(dirname(attemptStatePath(taskDirectory, attemptId)), { recursive: true, mode: 0o700 }),
	]);
	const durableTask = JSON.parse(await readFile(taskFile, "utf8")) as Record<string, unknown>;
	durableTask.currentAttemptId = attemptId;
	await writeJsonAtomic(taskFile, durableTask);
	const agentName = options.agentName ?? liveAgentName(options.task.id);
	if (options.start !== false) await options.herdr.startAgent({
		name: agentName, kind: "pi", paneId: options.paneId,
		args: childPiArgs(options.task, options.systemPromptFile), signal: options.signal,
	});
	// Delivery is attempted exactly once. Its acknowledgement is not a lifecycle
	// signal: Pi can recover from a transport/provider error in the same process.
	const promptController = new AbortController();
	const promptSignal = options.signal ? AbortSignal.any([options.signal, promptController.signal]) : promptController.signal;
	const prompt = options.herdr.promptAgent({ target: agentName, prompt: options.prompt, signal: promptSignal }).catch(() => undefined);
	const stalledTimer = options.stalledWarningMs ? setTimeout(() => options.onStalled?.(), options.stalledWarningMs) : undefined;
	try {
		while (true) {
			if (existsSync(attemptReportFile)) break;
			if (options.signal?.aborted) {
				if (existsSync(attemptReportFile)) break;
				throw options.signal.reason ?? new Error("Subagent attempt aborted.");
			}
			let alive = true;
			try { alive = await options.herdr.isTaskRunning(options.paneId, options.signal); }
			catch { /* an observation failure is not a child failure */ }
			if (!alive) {
				// The child publishes by atomic rename before it exits. Reconcile disk once;
				// there is no timing-based drain and no semantic use of idle/done.
				if (existsSync(attemptReportFile)) break;
				throw new Error("Child Pi exited without submitting a subagent_report.");
			}
			if (options.herdr.waitForAgentChange) await options.herdr.waitForAgentChange(agentName, options.signal).catch(() => undefined);
			else await pause(options.signal);
		}
	} finally {
		if (stalledTimer) clearTimeout(stalledTimer);
		promptController.abort(new Error("Task lifecycle settled; stop waiting for prompt acknowledgement."));
	}
	await prompt;
	let value: unknown;
	try { value = JSON.parse(await readFile(attemptReportFile, "utf8")); }
	catch {
		await rename(attemptReportFile, `${reportFile}.invalid-${Date.now()}`).catch(() => undefined);
		throw new Error("Child Pi submitted an invalid subagent_report.");
	}
	try {
		const report = parseReport(value, "child subagent_report");
		if (report.attemptId !== attemptId) throw new Error(`Report belongs to attempt '${report.attemptId ?? "unknown"}', expected '${attemptId}'.`);
		await writeJsonAtomic(reportFile, report);
		return { report, agentName, attemptId };
	} catch (error) {
		await rename(attemptReportFile, `${reportFile}.invalid-${Date.now()}`).catch(() => undefined);
		throw new Error(`Child Pi submitted an invalid subagent_report: ${error instanceof Error ? error.message : String(error)}`);
	}
}

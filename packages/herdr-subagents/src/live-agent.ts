import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HerdrAutomation } from "./herdr.ts";
import type { HerdrSubagentsReport } from "./runner.ts";
import { parseReport } from "./records.ts";
import { attemptReportPath, attemptStatePath, createAttemptId, type AttemptState } from "./attempts.ts";
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
		"--approve",
		"--session", task.sessionFile,
		"--name", `Subagent: ${task.name ?? task.agent ?? "worker"}`,
		"--no-extensions",
		"--extension", fileURLToPath(new URL("../extensions/subagent-report.ts", import.meta.url)),
		"--no-skills",
		"--append-system-prompt", systemPromptFile,
	];
	if (task.model) args.push("--model", task.model);
	if (task.thinking) args.push("--thinking", task.thinking);
	if (task.tools?.length) args.push("--tools", [...new Set([...task.tools, "subagent_report"])].join(","));
	for (const skill of task.skills ?? []) args.push("--skill", skill);
	return args;
}

export function liveAgentName(taskId: string, attempt = 1): string {
	return `herdr-subagent-${taskId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}-${attempt}`;
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
}): Promise<{ report: HerdrSubagentsReport; agentName: string; attemptId: string }> {
	const taskDirectory = dirname(options.task.sessionFile);
	const reportFile = join(taskDirectory, "report.json");
	const taskFile = join(taskDirectory, "task.json");
	const attemptId = createAttemptId();
	const attemptReportFile = attemptReportPath(taskDirectory, attemptId);
	const attemptStateFile = attemptStatePath(taskDirectory, attemptId);
	await Promise.all([mkdir(dirname(attemptReportFile), { recursive: true, mode: 0o700 }), mkdir(dirname(attemptStateFile), { recursive: true, mode: 0o700 })]);
	const durableTask = JSON.parse(await readFile(taskFile, "utf8")) as Record<string, unknown>;
	durableTask.currentAttemptId = attemptId;
	await writeJsonAtomic(taskFile, durableTask);
	const agentName = options.agentName ?? liveAgentName(options.task.id, options.attempt);
	if (options.start !== false) {
		await options.herdr.startAgent({
			name: agentName,
			kind: "pi",
			paneId: options.paneId,
			args: childPiArgs(options.task, options.systemPromptFile),
			signal: options.signal,
		});
	}
	const stalledTimer = options.stalledWarningMs ? setTimeout(() => options.onStalled?.(), options.stalledWarningMs) : undefined;
	let promptError: unknown;
	try { await options.herdr.promptAgent({ target: agentName, prompt: options.prompt, signal: options.signal }); }
	catch (error) { promptError = error; }
	finally { if (stalledTimer) clearTimeout(stalledTimer); }
	while (!existsSync(attemptReportFile)) {
		let state: AttemptState | undefined;
		if (existsSync(attemptStateFile)) {
			try {
				const value = JSON.parse(await readFile(attemptStateFile, "utf8")) as { attemptId?: unknown; state?: unknown };
				if (value.attemptId === attemptId && (value.state === "working" || value.state === "settled")) state = value.state;
			} catch { /* a concurrent atomic replacement will be retried */ }
		}
		if (state === "working") {
			try {
				if (!(await options.herdr.isTaskRunning(options.paneId, options.signal))) {
					if (promptError) throw promptError;
					throw new Error("Child Pi stopped while its authoritative attempt state was still working and did not submit a subagent_report.");
				}
			} catch (error) {
				if (error === promptError || (error instanceof Error && error.message.startsWith("Child Pi stopped while"))) throw error;
				// A transient liveness query is not evidence that the child stopped.
			}
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => { clearTimeout(timer); reject(options.signal?.reason ?? new Error("Subagent attempt aborted.")); };
				const timer = setTimeout(() => { options.signal?.removeEventListener("abort", onAbort); resolve(); }, 100);
				if (options.signal?.aborted) onAbort();
				else options.signal?.addEventListener("abort", onAbort, { once: true });
			});
			continue;
		}
		if (promptError) throw promptError;
		throw new Error(state === "settled" ? "Child Pi settled but did not submit a subagent_report." : "Child Pi stopped without an authoritative lifecycle state and did not submit a subagent_report.");
	}
	let value: unknown;
	try { value = JSON.parse(await readFile(attemptReportFile, "utf8")); }
	catch {
		await rename(attemptReportFile, `${reportFile}.invalid-${Date.now()}`).catch(() => undefined);
		if (promptError) throw new Error(`${promptError instanceof Error ? promptError.message : String(promptError)}; Child Pi also submitted an invalid subagent_report.`);
		throw new Error("Child Pi submitted an invalid subagent_report.");
	}
	try {
		const report = parseReport(value, "child subagent_report") as HerdrSubagentsReport;
		if (report.attemptId !== attemptId) throw new Error(`Report belongs to attempt '${report.attemptId ?? "unknown"}', expected '${attemptId}'.`);
		await writeJsonAtomic(reportFile, report);
		return { report, agentName, attemptId };
	}
	catch (error) {
		await rename(attemptReportFile, `${reportFile}.invalid-${Date.now()}`).catch(() => undefined);
		const detail = `Child Pi submitted an invalid subagent_report: ${error instanceof Error ? error.message : String(error)}`;
		throw new Error(promptError ? `${promptError instanceof Error ? promptError.message : String(promptError)}; ${detail}` : detail);
	}
}

import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HerdrAgentState, HerdrAutomation } from "./herdr.ts";
import { applyTaskRuntime, parseReport, readTaskRecord, type PersistedReport, type TaskRecord, type TaskRuntimeState } from "./records.ts";
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
		"--extension", "builtin:codemode",
		"--extension", fileURLToPath(new URL("../extensions/subagent-report.ts", import.meta.url)),
		"--no-skills",
		"--append-system-prompt", systemPromptFile,
	];
	if (task.model) args.push("--model", task.model);
	if (task.thinking) args.push("--thinking", task.thinking);
	if (task.tools?.length) args.push("--tools", [...new Set([...task.tools, "codemode", "subagent_report"])].join(","));
	else args.push("--tools", "+codemode");
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
	onRuntimeUpdate?: (task: TaskRecord) => void | Promise<void>;
	attemptId?: string;
}): Promise<{ report: PersistedReport; agentName: string; attemptId: string }> {
	const taskDirectory = dirname(options.task.sessionFile);
	const reportFile = join(taskDirectory, "report.json");
	const taskFile = join(taskDirectory, "task.json");
	const attemptId = options.attemptId ?? createAttemptId();
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
	const persistRuntime = async (state: TaskRuntimeState, diagnostic?: string) => {
		const task = await readTaskRecord(taskFile);
		if (task.currentAttemptId !== attemptId || (task.status !== "running" && task.status !== "starting")) return;
		if (task.runtimeState === state && task.runtimeDiagnostic === diagnostic) return;
		applyTaskRuntime(task, state, diagnostic);
		await writeJsonAtomic(taskFile, task);
		await options.onRuntimeUpdate?.(task);
	};
	const readAttemptState = async (): Promise<AttemptState | undefined> => {
		if (!existsSync(attemptStateFile)) return undefined;
		try {
			const value = JSON.parse(await readFile(attemptStateFile, "utf8")) as { attemptId?: unknown; state?: unknown };
			if (value.attemptId === attemptId && (value.state === "working" || value.state === "settled")) return value.state;
		} catch { /* a concurrent atomic replacement will be retried */ }
		return undefined;
	};
	const wait = () => new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			if (existsSync(attemptReportFile)) resolve();
			else reject(options.signal?.reason ?? new Error("Subagent attempt aborted."));
		};
		const timer = setTimeout(() => { options.signal?.removeEventListener("abort", onAbort); resolve(); }, 100);
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
	});
	const promptController = new AbortController();
	const abortPrompt = () => promptController.abort(options.signal?.reason ?? new Error("Subagent prompt wait stopped."));
	if (options.signal?.aborted) abortPrompt();
	else options.signal?.addEventListener("abort", abortPrompt, { once: true });
	const promptOutcome = options.herdr.promptAgent({ target: agentName, prompt: options.prompt, signal: promptController.signal })
		.then((result) => ({ result }), (error: unknown) => ({ error }));
	let promptSettled = false;
	let promptStatus: HerdrAgentState | undefined;
	let promptError: unknown;
	const promptSettlementWork = promptOutcome.then(async (outcome) => {
		promptSettled = true;
		if ("error" in outcome) {
			promptError = outcome.error;
			const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
			if (/agent_prompt_stalled|timed?\s*out|timeout/i.test(detail)) await persistRuntime("delivery_unknown", detail);
			else if (/agent_blocked/i.test(detail)) await persistRuntime("waiting_interaction", "Herdr is waiting for an approval or interaction; no business input request has been reported.");
		} else if (outcome.result.status === "working" || outcome.result.status === "blocked" || outcome.result.status === "idle" || outcome.result.status === "done") promptStatus = outcome.result.status;
	});
	const stalledTimer = options.stalledWarningMs ? setTimeout(() => options.onStalled?.(), options.stalledWarningMs) : undefined;
	let terminalObservedAt: number | undefined;
	try {
		await persistRuntime("working");
		while (!existsSync(attemptReportFile)) {
			await Promise.resolve();
			let agentState = promptStatus;
			let observationDiagnostic: string | undefined;
			try { agentState = await options.herdr.getAgentState(agentName, options.signal); }
			catch (error) { observationDiagnostic = `Could not observe Herdr agent state: ${error instanceof Error ? error.message : String(error)}`; }
			const attemptState = await readAttemptState();
			const promptDetail = promptError instanceof Error ? promptError.message : promptError === undefined ? "" : String(promptError);
			if (agentState === "blocked" || /agent_blocked/i.test(promptDetail)) {
				await persistRuntime("waiting_interaction", observationDiagnostic ?? "Herdr is waiting for an approval or interaction; no business input request has been reported.");
				terminalObservedAt = undefined;
			} else if (promptError && /agent_prompt_stalled|timed?\s*out|timeout/i.test(promptDetail)) {
				await persistRuntime("delivery_unknown", observationDiagnostic ?? promptDetail);
				let live = false;
				try { live = await options.herdr.isTaskRunning(options.paneId, options.signal); } catch { live = true; }
				if (attemptState !== "working" || !live) {
					terminalObservedAt ??= Date.now();
					if (Date.now() - terminalObservedAt >= 50) throw promptError;
				}
			} else if (promptError && promptSettled) {
				terminalObservedAt ??= Date.now();
				if (Date.now() - terminalObservedAt >= 50) throw promptError;
			} else if ((promptSettled || attemptState === "settled") && (agentState === "idle" || agentState === "done" || attemptState === "settled")) {
				if (attemptState === "working") {
					let live = false;
					try { live = await options.herdr.isTaskRunning(options.paneId, options.signal); } catch { live = true; }
					if (!live) throw new Error("Child Pi stopped while its authoritative attempt state was still working and did not submit a subagent_report.");
				}
				terminalObservedAt ??= Date.now();
				if (Date.now() - terminalObservedAt >= 50) throw new Error("Child Pi did not submit a subagent_report before settling.");
			} else {
				await persistRuntime("working", observationDiagnostic);
				terminalObservedAt = undefined;
				if (!observationDiagnostic && agentState === "unknown") {
					let live = false;
					try { live = await options.herdr.isTaskRunning(options.paneId, options.signal); } catch { live = true; }
					if (!live) throw new Error("Child Pi stopped without submitting a subagent_report.");
				}
			}
			await wait();
		}
	} finally {
		if (stalledTimer) clearTimeout(stalledTimer);
		promptController.abort(new Error("Authoritative subagent_report observed; stop waiting for prompt acknowledgement."));
		await promptSettlementWork;
		options.signal?.removeEventListener("abort", abortPrompt);
	}
	let value: unknown;
	try { value = JSON.parse(await readFile(attemptReportFile, "utf8")); }
	catch {
		await rename(attemptReportFile, `${reportFile}.invalid-${Date.now()}`).catch(() => undefined);
		if (promptError) throw new Error(`${promptError instanceof Error ? promptError.message : String(promptError)}; Child Pi also submitted an invalid subagent_report.`);
		throw new Error("Child Pi submitted an invalid subagent_report.");
	}
	try {
		const report = parseReport(value, "child subagent_report");
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

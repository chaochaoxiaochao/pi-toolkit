import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { HerdrAutomation } from "./herdr.ts";
import { liveAgentName, promptLiveAgent } from "./live-agent.ts";
import { writeJsonAtomic } from "./state.ts";
import { cleanupRunTab } from "./tab-cleanup.ts";
import { RunPaneAllocator } from "./run-pane-allocator.ts";
import { aggregateTaskStatus, applyRunStatus } from "./run-status.ts";
import { applyReport, applyTaskStatus, readRunRecord, readTaskRecord, settleAttemptFailure } from "./records.ts";
import { isAbortError } from "./errors.ts";

export interface ContinueQueuedRunOptions {
	cleanup?: boolean;
	onStalled?: (message: string) => void;
	onCleanupError?: (message: string) => void;
	onUpdate?: () => void | Promise<void>;
	signal?: AbortSignal;
}

export async function continueQueuedRun(runDirectory: string, herdr: HerdrAutomation, options: ContinueQueuedRunOptions = {}): Promise<void> {
	const runFile = join(runDirectory, "run.json");
	const run = await readRunRecord(runFile);
	const taskDirectories = readdirSync(join(runDirectory, "tasks")).sort().map((entry) => join(runDirectory, "tasks", entry));
	const queuedDirectories: string[] = [];
	let blockedCount = 0;
	for (const directory of taskDirectories) {
		const status = (await readTaskRecord(join(directory, "task.json"))).status;
		if (status === "queued") queuedDirectories.push(directory);
		if (status === "blocked") blockedCount += 1;
	}
	if (!queuedDirectories.length) return;
	const availableSlots = Math.max(0, (Number(run.effectiveConcurrency) || 1) - blockedCount);
	if (availableSlots === 0) return;
	const concurrency = Math.min(availableSlots, queuedDirectories.length);
	const paneAllocator = new RunPaneAllocator({ herdr, run, runFile, signal: options.signal, validateExistingPane: true, onCleanupError: options.onCleanupError });
	let nextIndex = 0;
	const runOne = async (directory: string): Promise<string> => {
		const taskFile = join(directory, "task.json");
		const task = await readTaskRecord(taskFile);
		let paneId = "";
		const reportFile = join(directory, "report.json");
		try {
			paneId = await paneAllocator.allocate(directory);
			const agentName = liveAgentName(task.id, Number(task.attempt ?? 0) + 1);
			const paneLabel = `${String(task.order).padStart(2, "0")} · ${task.name ?? task.agent}`;
			await herdr.renamePane(paneId, paneLabel, options.signal);
			applyTaskStatus(task, "running");
			Object.assign(task, { tabId: run.tabId, paneId, paneLabel, agentName, attempt: Number(task.attempt ?? 0) + 1, startedAt: new Date().toISOString() });
			await writeJsonAtomic(taskFile, task);
			await options.onUpdate?.();
			const report = (await promptLiveAgent({ herdr, task: { ...task, id: task.id, sessionFile: task.sessionFile }, paneId, prompt: task.prompt, systemPromptFile: join(directory, "system-prompt.md"), agentName, signal: options.signal, stalledWarningMs: run.stalledWarningSeconds ? Number(run.stalledWarningSeconds) * 1000 : undefined, onStalled: () => options.onStalled?.(`${task.name ?? task.agent} appears stalled; it is still running.`) })).report;
			applyReport(task, report);
		} catch (error) {
			await settleAttemptFailure(task, reportFile, {
				cancelled: isAbortError(error, options.signal),
				error: error instanceof Error ? error.message : String(error),
				name: String(task.name ?? task.agent ?? "Task"),
			});
		}
		await writeJsonAtomic(taskFile, task);
		await options.onUpdate?.();
		return task.status;
	};
	const worker = async () => {
		while (true) {
			const index = nextIndex++;
			if (index >= queuedDirectories.length) return;
			if (await runOne(queuedDirectories[index]) === "blocked") return;
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
	if (options.signal?.aborted) {
		for (const directory of taskDirectories) {
			const taskFile = join(directory, "task.json");
			const task = await readTaskRecord(taskFile);
			if (task.status !== "queued") continue;
			applyTaskStatus(task, "cancelled", { error: "Parent Pi session closed." });
			await writeJsonAtomic(taskFile, task);
		}
	}
	const statuses = await Promise.all(taskDirectories.map(async (directory) => (await readTaskRecord(join(directory, "task.json"))).status));
	applyRunStatus(run, options.signal?.aborted ? "cancelled" : aggregateTaskStatus(statuses));
	await writeJsonAtomic(runFile, run);
	if (options.cleanup !== false && run.status !== "blocked" && run.tabId) {
		await cleanupRunTab({ herdr, tabId: run.tabId, runFile, runRecord: run, signal: options.signal, onError: options.onCleanupError, failureStatus: "failed" });
	}
}

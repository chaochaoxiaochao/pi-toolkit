import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HerdrAutomation } from "./herdr.ts";
import { isProcessAlive, type OwnerIdentity } from "./ownership.ts";
import { writeJsonAtomic } from "./state.ts";
import { aggregateTaskStatus, applyRunStatus } from "./run-status.ts";
import { applyReport, applyTaskStatus, isActiveStatus, persistFailureReport, readReport, readRunRecord, readTaskRecord, type RunRecord, type TaskStatus } from "./records.ts";
import { cleanupRunTab } from "./tab-cleanup.ts";


export interface CancellationResult { cancelledRuns: number; cleanupErrors: string[]; }
export interface ReconciliationResult { liveTasks: number; settledTasks: number; interruptedTasks: number; cancelledTasks: number; cleanupErrors: string[]; }

async function closeRunTab(run: RunRecord, runFile: string, herdr: HerdrAutomation, cleanupErrors: string[]): Promise<void> {
	if (!run.tabId) return;
	const forceClose = new AbortController();
	forceClose.abort(new Error("Owning parent Pi session is no longer active."));
	const errorsBeforeCleanup = cleanupErrors.length;
	try {
		await cleanupRunTab({ herdr, tabId: run.tabId, runFile, runRecord: run, signal: forceClose.signal, onError: (message) => cleanupErrors.push(message), errorPrefix: `Could not close Subagent tab ${run.tabId}` });
	} catch (error) {
		if (cleanupErrors.length === errorsBeforeCleanup) cleanupErrors.push(`Could not close Subagent tab ${run.tabId}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export interface CancelActiveRunsOptions { reason?: string; owner?: OwnerIdentity; }

export async function cancelActiveSubagentRuns(cwd: string, herdr: HerdrAutomation, options: CancelActiveRunsOptions = {}): Promise<CancellationResult> {
	const reason = options.reason ?? "Parent Pi session closed.";
	const result: CancellationResult = { cancelledRuns: 0, cleanupErrors: [] };
	const runsDirectory = join(cwd, ".pi", "herdr-subagents", "runs");
	if (!existsSync(runsDirectory)) return result;
	for (const runEntry of readdirSync(runsDirectory)) {
		const runDirectory = join(runsDirectory, runEntry);
		const runFile = join(runDirectory, "run.json");
		let run: RunRecord;
		try { run = await readRunRecord(runFile); }
		catch (error) {
			result.cleanupErrors.push(`Could not inspect Subagent run ${runFile}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!isActiveStatus(run.status)) continue;
		if (options.owner?.sessionId && run.ownerSessionId !== options.owner.sessionId) continue;
		const now = new Date().toISOString();
		const tasksDirectory = join(runDirectory, "tasks");
		if (existsSync(tasksDirectory)) for (const taskEntry of readdirSync(tasksDirectory)) {
			const taskFile = join(tasksDirectory, taskEntry, "task.json");
			let task;
			try { task = await readTaskRecord(taskFile); }
			catch (error) {
				result.cleanupErrors.push(`Could not cancel Subagent task ${taskFile}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			if (!isActiveStatus(task.status)) continue;
			applyTaskStatus(task, "cancelled", { error: reason, at: now });
			await writeJsonAtomic(taskFile, task);
		}
		applyRunStatus(run, "cancelled", { error: reason, at: now });
		await writeJsonAtomic(runFile, run);
		await closeRunTab(run, runFile, herdr, result.cleanupErrors);
		result.cancelledRuns += 1;
	}
	return result;
}

export async function reconcileSubagentRuns(cwd: string, herdr: HerdrAutomation, owner?: OwnerIdentity): Promise<ReconciliationResult> {
	const result: ReconciliationResult = { liveTasks: 0, settledTasks: 0, interruptedTasks: 0, cancelledTasks: 0, cleanupErrors: [] };
	const runsDirectory = join(cwd, ".pi", "herdr-subagents", "runs");
	if (!existsSync(runsDirectory)) return result;
	for (const runEntry of readdirSync(runsDirectory)) {
		const runDirectory = join(runsDirectory, runEntry);
		const runFile = join(runDirectory, "run.json");
		let run: RunRecord;
		try { run = await readRunRecord(runFile); }
		catch (error) {
			result.cleanupErrors.push(`Could not inspect Subagent run ${runFile}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const differentOwner = owner?.sessionId !== undefined && run.ownerSessionId !== owner.sessionId;
		if (differentOwner && run.ownerProcessId !== (owner?.processId ?? process.pid) && isProcessAlive(run.ownerProcessId)) continue;
		for (const pendingTabId of [...(run.cleanupPendingTabIds ?? [])]) {
			const errorsBeforeCleanup = result.cleanupErrors.length;
			try {
				await cleanupRunTab({ herdr, tabId: pendingTabId, runFile, runRecord: run, onError: (message) => result.cleanupErrors.push(message), errorPrefix: `Could not finish deferred cleanup for Herdr tab ${pendingTabId}` });
			} catch (error) {
				if (result.cleanupErrors.length === errorsBeforeCleanup) result.cleanupErrors.push(`Could not finish deferred cleanup for Herdr tab ${pendingTabId}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (!isActiveStatus(run.status)) continue;
		const tasksDirectory = join(runDirectory, "tasks");
		if (!existsSync(tasksDirectory)) {
			const message = `Active Subagent run ${run.id} has no tasks directory.`;
			result.cleanupErrors.push(message);
			applyRunStatus(run, "failed", { error: message });
			await writeJsonAtomic(runFile, run);
			await closeRunTab(run, runFile, herdr, result.cleanupErrors);
			continue;
		}
		const statuses: TaskStatus[] = [];
		let unreadableTasks = 0;
		for (const taskEntry of readdirSync(tasksDirectory)) {
			const taskFile = join(tasksDirectory, taskEntry, "task.json");
			let task;
			try { task = await readTaskRecord(taskFile); }
			catch (error) {
				result.cleanupErrors.push(`Could not inspect Subagent task ${taskFile}: ${error instanceof Error ? error.message : String(error)}`);
				unreadableTasks += 1;
				continue;
			}
			if (isActiveStatus(task.status)) {
				const reportFile = join(tasksDirectory, taskEntry, "report.json");
				if (existsSync(reportFile) && (task.status === "running" || task.status === "starting")) {
					try {
						const report = await readReport(reportFile);
						applyReport(task, report, report.reportedAt ?? new Date().toISOString());
						result.settledTasks += 1;
					} catch (error) {
						const detail = error instanceof Error ? error.message : String(error);
						result.cleanupErrors.push(`Invalid Subagent report ${reportFile}: ${detail}`);
						await persistFailureReport(reportFile, { status: "failed", summary: "Recovered task had an invalid structured report.", documents: [], error: detail, reportedAt: new Date().toISOString() });
						if (!differentOwner) {
							applyTaskStatus(task, "failed", { error: `Invalid structured report: ${detail}` });
							result.settledTasks += 1;
							result.interruptedTasks += 1;
						}
					}
				}
				if (differentOwner && isActiveStatus(task.status)) {
					applyTaskStatus(task, "cancelled", { error: "Owning parent Pi session is no longer active." });
					result.cancelledTasks += 1;
					result.interruptedTasks += 1;
				} else if (!differentOwner && (task.status === "running" || task.status === "starting")) {
					let childIsLive = false;
					if (task.paneId) {
						try { childIsLive = await herdr.isTaskRunning(task.paneId); }
						catch (error) {
							result.cleanupErrors.push(`Could not inspect Subagent pane ${task.paneId}: ${error instanceof Error ? error.message : String(error)}`);
							childIsLive = true;
						}
					}
					if (childIsLive) result.liveTasks += 1;
					else {
						applyTaskStatus(task, "cancelled", { error: "Child pane disappeared before a structured report was recorded." });
						result.cancelledTasks += 1;
						result.interruptedTasks += 1;
					}
				}
				await writeJsonAtomic(taskFile, task);
			}
			statuses.push(task.status);
		}
		if (unreadableTasks > 0) {
			const message = `Could not reconcile ${unreadableTasks} unreadable task record${unreadableTasks === 1 ? "" : "s"}.`;
			applyRunStatus(run, "failed", { error: message });
			await writeJsonAtomic(runFile, run);
			await closeRunTab(run, runFile, herdr, result.cleanupErrors);
			result.interruptedTasks += unreadableTasks;
			continue;
		}
		if (differentOwner || !statuses.some((status) => status === "running" || status === "starting")) {
			applyRunStatus(run, differentOwner ? "cancelled" : aggregateTaskStatus(statuses), { error: differentOwner ? "Owning parent Pi session is no longer active." : undefined });
			await writeJsonAtomic(runFile, run);
			if (differentOwner || run.status === "cancelled") await closeRunTab(run, runFile, herdr, result.cleanupErrors);
		}
	}
	return result;
}

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HerdrAutomation } from "./herdr.ts";
import { isProcessAlive } from "./ownership.ts";
import { writeJsonAtomic } from "./state.ts";

async function readJson(path: string): Promise<Record<string, any>> { return JSON.parse(await readFile(path, "utf8")) as Record<string, any>; }
const ACTIVE = ["starting", "running", "queued", "blocked"];

export interface CancellationResult { cancelledRuns: number; cleanupErrors: string[]; }
export interface ReconciliationResult { liveTasks: number; settledTasks: number; interruptedTasks: number; cancelledTasks: number; cleanupErrors: string[]; }

async function closeRunTab(run: Record<string, any>, runFile: string, herdr: HerdrAutomation, cleanupErrors: string[]): Promise<void> {
	if (!run.tabId) return;
	try { await herdr.closeTab(run.tabId); }
	catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const message = `Could not close Subagent tab ${run.tabId}: ${detail}`;
		run.cleanupError = detail;
		await writeJsonAtomic(runFile, run);
		cleanupErrors.push(message);
	}
}

export async function cancelActiveSubagentRuns(cwd: string, herdr: HerdrAutomation, reason = "Parent Pi session closed.", ownerSessionId?: string): Promise<CancellationResult> {
	const result: CancellationResult = { cancelledRuns: 0, cleanupErrors: [] };
	const runsDirectory = join(cwd, ".pi", "herdr-subagents", "runs");
	if (!existsSync(runsDirectory)) return result;
	for (const runEntry of readdirSync(runsDirectory)) {
		const runDirectory = join(runsDirectory, runEntry);
		const runFile = join(runDirectory, "run.json");
		let run: Record<string, any>;
		try { run = await readJson(runFile); } catch { continue; }
		if (!ACTIVE.includes(run.status)) continue;
		if (ownerSessionId && run.ownerSessionId !== ownerSessionId) continue;
		const now = new Date().toISOString();
		const tasksDirectory = join(runDirectory, "tasks");
		if (existsSync(tasksDirectory)) for (const taskEntry of readdirSync(tasksDirectory)) {
			const taskFile = join(tasksDirectory, taskEntry, "task.json");
			const task = await readJson(taskFile);
			if (!ACTIVE.includes(task.status)) continue;
			Object.assign(task, { status: "cancelled", error: reason, completedAt: now });
			await writeJsonAtomic(taskFile, task);
		}
		Object.assign(run, { status: "cancelled", error: reason, completedAt: now });
		await writeJsonAtomic(runFile, run);
		await closeRunTab(run, runFile, herdr, result.cleanupErrors);
		result.cancelledRuns += 1;
	}
	return result;
}

export async function reconcileSubagentRuns(cwd: string, herdr: HerdrAutomation, currentOwnerSessionId?: string, currentOwnerProcessId = process.pid): Promise<ReconciliationResult> {
	const result: ReconciliationResult = { liveTasks: 0, settledTasks: 0, interruptedTasks: 0, cancelledTasks: 0, cleanupErrors: [] };
	const runsDirectory = join(cwd, ".pi", "herdr-subagents", "runs");
	if (!existsSync(runsDirectory)) return result;
	for (const runEntry of readdirSync(runsDirectory)) {
		const runDirectory = join(runsDirectory, runEntry);
		const runFile = join(runDirectory, "run.json");
		let run: Record<string, any>;
		try { run = await readJson(runFile); } catch { continue; }
		if (!ACTIVE.includes(run.status)) continue;
		const differentOwner = currentOwnerSessionId !== undefined && run.ownerSessionId !== currentOwnerSessionId;
		if (differentOwner && run.ownerProcessId !== currentOwnerProcessId && isProcessAlive(run.ownerProcessId)) continue;
		const orphaned = differentOwner;
		const statuses: string[] = [];
		const tasksDirectory = join(runDirectory, "tasks");
		if (!existsSync(tasksDirectory)) continue;
		for (const taskEntry of readdirSync(tasksDirectory)) {
			const taskDirectory = join(tasksDirectory, taskEntry);
			const taskFile = join(taskDirectory, "task.json");
			const task = await readJson(taskFile);
			if (ACTIVE.includes(task.status)) {
				const reportFile = join(taskDirectory, "report.json");
				if (existsSync(reportFile) && (task.status === "running" || task.status === "starting")) {
					const report = await readJson(reportFile);
					task.status = report.status === "needs-input" ? "blocked" : report.status;
					task.completedAt = report.reportedAt ?? new Date().toISOString();
					if (report.error) task.error = report.error;
					if (report.question) task.question = report.question;
					result.settledTasks += 1;
				}
				if (orphaned && ACTIVE.includes(task.status)) {
					task.status = "cancelled";
					task.error = "Owning parent Pi session is no longer active.";
					task.completedAt = new Date().toISOString();
					result.cancelledTasks += 1;
					result.interruptedTasks += 1;
				} else if (!orphaned && (task.status === "running" || task.status === "starting")) {
					if (task.paneId && await herdr.isTaskRunning(task.paneId)) result.liveTasks += 1;
					else {
						task.status = "cancelled";
						task.error = "Child pane disappeared before a structured report was recorded.";
						task.completedAt = new Date().toISOString();
						result.cancelledTasks += 1;
						result.interruptedTasks += 1;
					}
				}
				await writeJsonAtomic(taskFile, task);
			}
			statuses.push(task.status);
		}
		if (orphaned || !statuses.some((status) => status === "running" || status === "starting")) {
			run.status = statuses.every((status) => status === "completed") ? "completed" : statuses.some((status) => status === "cancelled") ? "cancelled" : statuses.some((status) => status === "blocked" || status === "queued") ? "blocked" : statuses.some((status) => status === "failed") ? (statuses.some((status) => status === "completed") ? "partial" : "failed") : "completed";
			run.completedAt = new Date().toISOString();
			await writeJsonAtomic(runFile, run);
			if (orphaned || run.status === "cancelled") await closeRunTab(run, runFile, herdr, result.cleanupErrors);
		}
	}
	return result;
}

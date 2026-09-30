import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HerdrAutomation } from "./herdr.ts";
import { writeJsonAtomic } from "./state.ts";

async function readJson(path: string): Promise<Record<string, any>> { return JSON.parse(await readFile(path, "utf8")) as Record<string, any>; }

export interface ReconciliationResult { liveTasks: number; settledTasks: number; interruptedTasks: number; }

export async function reconcileSubagentRuns(cwd: string, herdr: HerdrAutomation): Promise<ReconciliationResult> {
	const result: ReconciliationResult = { liveTasks: 0, settledTasks: 0, interruptedTasks: 0 };
	const runsDirectory = join(cwd, ".pi", "herdr-subagents", "runs");
	if (!existsSync(runsDirectory)) return result;
	for (const runEntry of readdirSync(runsDirectory)) {
		const runDirectory = join(runsDirectory, runEntry);
		const runFile = join(runDirectory, "run.json");
		let run: Record<string, any>;
		try { run = await readJson(runFile); } catch { continue; }
		if (run.status !== "running" && run.status !== "starting") continue;
		const statuses: string[] = [];
		let runLiveTasks = 0;
		const tasksDirectory = join(runDirectory, "tasks");
		if (!existsSync(tasksDirectory)) continue;
		for (const taskEntry of readdirSync(tasksDirectory)) {
			const taskDirectory = join(tasksDirectory, taskEntry);
			const taskFile = join(taskDirectory, "task.json");
			const task = await readJson(taskFile);
			if (task.status === "running" || task.status === "starting") {
				const reportFile = join(taskDirectory, "report.json");
				if (existsSync(reportFile)) {
					const report = await readJson(reportFile);
					task.status = report.status === "needs-input" ? "blocked" : report.status;
					task.completedAt = report.reportedAt ?? new Date().toISOString();
					if (report.error) task.error = report.error;
					if (report.question) task.question = report.question;
					await writeJsonAtomic(taskFile, task);
					result.settledTasks += 1;
				} else if (task.paneId && await herdr.paneExists(task.paneId)) { result.liveTasks += 1; runLiveTasks += 1; }
				else {
					task.status = "interrupted";
					task.error = "Child pane disappeared before a structured report was recorded.";
					task.completedAt = new Date().toISOString();
					await writeJsonAtomic(taskFile, task);
					result.interruptedTasks += 1;
				}
			}
			statuses.push(task.status);
		}
		if (runLiveTasks === 0 || !statuses.some((status) => status === "running" || status === "starting")) {
			run.status = statuses.length === 0 ? "interrupted" : statuses.some((status) => status === "blocked") ? "blocked" : statuses.some((status) => status === "queued") ? "queued" : statuses.some((status) => status === "interrupted") ? "interrupted" : statuses.some((status) => status === "failed") ? (statuses.some((status) => status === "completed") ? "partial" : "failed") : "completed";
			run.completedAt = new Date().toISOString();
			await writeJsonAtomic(runFile, run);
		}
	}
	return result;
}

import type { BatchResult } from "./batch-runner.ts";
import type { HerdrAutomation } from "./herdr.ts";

export function activityCounts(run: Pick<BatchResult, "activity">): Record<"running" | "queued" | "blocked" | "failed" | "completed", number> {
	const count = (status: string) => run.activity.filter((task) => task.status === status).length;
	return { running: count("running"), queued: count("queued"), blocked: count("blocked"), failed: count("failed"), completed: count("completed") };
}

export function activeRunText(run: Pick<BatchResult, "label" | "runId" | "activity">): string {
	return [`${run.label} (${run.runId})`, ...run.activity.map((task) => `${task.index + 1}. ${task.name}: ${task.status}`)].join("\n");
}

export async function focusActiveTask(run: Pick<BatchResult, "activity"> | undefined, taskNumber: number, herdr: HerdrAutomation): Promise<boolean> {
	const task = run?.activity.find((candidate) => candidate.index === taskNumber - 1);
	if (!task?.paneId || (task.status !== "running" && task.status !== "blocked")) return false;
	await herdr.focusPane(task.paneId);
	return true;
}

export type AggregateRunStatus = "running" | "blocked" | "completed" | "partial" | "failed" | "cancelled";

export function aggregateTaskStatus(statuses: readonly string[]): AggregateRunStatus {
	if (statuses.some((status) => status === "running" || status === "starting")) return "running";
	if (statuses.some((status) => status === "blocked" || status === "queued")) return "blocked";
	const completed = statuses.some((status) => status === "completed");
	if (statuses.some((status) => status === "cancelled")) return completed ? "partial" : "cancelled";
	if (statuses.some((status) => status === "failed" || status === "interrupted")) return completed ? "partial" : "failed";
	return "completed";
}

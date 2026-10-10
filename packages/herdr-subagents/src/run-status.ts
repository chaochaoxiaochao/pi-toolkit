import { applyLifecycleStatus, type RunStatus, type TaskStatus } from "./records.ts";

export type AggregateRunStatus = Exclude<RunStatus, "starting" | "queued">;
export type PersistedRunStatus = RunStatus;

export function aggregateTaskStatus(statuses: readonly TaskStatus[]): AggregateRunStatus {
	if (statuses.length === 0) return "failed";
	if (statuses.some((status) => status === "running" || status === "starting")) return "running";
	if (statuses.some((status) => status === "blocked" || status === "queued")) return "blocked";
	if (statuses.every((status) => status === "cancelled")) return "cancelled";
	if (statuses.every((status) => status === "failed")) return "failed";
	if (statuses.some((status) => status === "cancelled" || status === "failed")) return "partial";
	if (statuses.every((status) => status === "completed")) return "completed";
	throw new Error(`Cannot aggregate unknown task status: ${statuses.join(", ")}`);
}

export function applyRunStatus<T extends { status: string; question?: string; error?: string; updatedAt?: string; completedAt?: string }>(
	run: T,
	status: PersistedRunStatus,
	options: { question?: string; error?: string; at?: string } = {},
): T {
	return applyLifecycleStatus(run, status, options);
}

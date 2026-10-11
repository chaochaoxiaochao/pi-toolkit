import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive, type OwnerIdentity } from "./ownership.ts";
import { aggregateTaskStatus, type AggregateRunStatus } from "./run-status.ts";
import type { ResumeMember, RunRecord, TaskRecord, TaskStatus } from "./records.ts";
import { readTaskRecord } from "./records.ts";

export interface TaskEntry { directory: string; task: TaskRecord }
export interface ResumeCleanupClaim { tabId: string; generation: number }

export async function readTaskEntries(runDirectory: string): Promise<TaskEntry[]> {
	return Promise.all(readdirSync(join(runDirectory, "tasks")).sort().map(async (entry) => {
		const directory = join(runDirectory, "tasks", entry);
		return { directory, task: await readTaskRecord(join(directory, "task.json")) };
	}));
}

export function memberCoversTask(member: ResumeMember | undefined, task: TaskRecord): boolean {
	if (!member) return false;
	if (member.phase === "allocating") return true;
	return member.attemptId === task.currentAttemptId && member.phase === "running";
}

export function aggregateTasksWithResume(tasks: readonly TaskRecord[], active: Record<string, ResumeMember> = {}): AggregateRunStatus {
	return aggregateTaskStatus(tasks.map((task): TaskStatus => memberCoversTask(active[task.id], task) ? "running" : task.status));
}

export function memberOwnedBy(member: ResumeMember, owner?: OwnerIdentity): boolean {
	if (!owner) return true;
	if (owner.sessionId !== undefined && member.ownerSessionId !== owner.sessionId) return false;
	if (owner.processId !== undefined && member.ownerProcessId !== owner.processId) return false;
	return true;
}

export function memberOwnerIsStale(member: ResumeMember, currentOwner?: OwnerIdentity): boolean {
	if (currentOwner && memberOwnedBy(member, currentOwner)) return false;
	if (currentOwner?.sessionId && member.ownerSessionId && currentOwner.sessionId !== member.ownerSessionId && member.ownerProcessId === currentOwner.processId) return true;
	return !isProcessAlive(member.ownerProcessId);
}

export function claimResumeCleanup(run: RunRecord): ResumeCleanupClaim | undefined {
	if (!run.resume || run.resume.phase !== "active" || Object.keys(run.resume.active).length > 0) return undefined;
	run.resume.phase = "closing";
	run.cleanupPendingTabIds = [...new Set([...(run.cleanupPendingTabIds ?? []), run.resume.tabId])];
	return { tabId: run.resume.tabId, generation: run.resume.generation };
}

import { randomUUID } from "node:crypto";
import { join } from "node:path";

const ATTEMPT_ID = /^[a-f0-9-]{36}$/i;

export type AttemptState = "working" | "settled";

export function createAttemptId(): string { return randomUUID(); }

export function requireAttemptId(value: unknown): string {
	if (typeof value !== "string" || !ATTEMPT_ID.test(value)) throw new Error("Subagent attempt has no valid attempt ID.");
	return value;
}

export function attemptReportPath(taskDirectory: string, attemptId: string): string {
	return join(taskDirectory, "reports", `${requireAttemptId(attemptId)}.json`);
}

export function attemptStatePath(taskDirectory: string, attemptId: string): string {
	return join(taskDirectory, "attempts", `${requireAttemptId(attemptId)}.json`);
}

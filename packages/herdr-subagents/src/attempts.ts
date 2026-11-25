import { randomUUID } from "node:crypto";
import { join } from "node:path";

const ATTEMPT_ID = /^[a-f0-9-]{36}$/i;

export type AttemptState = "working" | "waiting_interaction" | "settled";

export interface PersistedAttemptState {
	attemptId: string;
	state: AttemptState;
	at: string;
	diagnostic?: string;
}

export function createAttemptId(): string { return randomUUID(); }

export function requireAttemptId(value: unknown): string {
	if (typeof value !== "string" || !ATTEMPT_ID.test(value)) throw new Error("Subagent attempt has no valid attempt ID.");
	return value;
}

export function parseAttemptState(value: unknown, source = "attempt state"): PersistedAttemptState {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${source}.`);
	const record = value as Record<string, unknown>;
	const attemptId = requireAttemptId(record.attemptId);
	if (record.state !== "working" && record.state !== "waiting_interaction" && record.state !== "settled") {
		throw new Error(`Invalid ${source} state.`);
	}
	if (typeof record.at !== "string" || !record.at) throw new Error(`Invalid ${source} timestamp.`);
	if (record.diagnostic !== undefined && (typeof record.diagnostic !== "string" || !record.diagnostic.trim())) {
		throw new Error(`Invalid ${source} diagnostic.`);
	}
	return {
		attemptId,
		state: record.state,
		at: record.at,
		...(typeof record.diagnostic === "string" ? { diagnostic: record.diagnostic } : {}),
	};
}

export function attemptReportPath(taskDirectory: string, attemptId: string): string {
	return join(taskDirectory, "reports", `${requireAttemptId(attemptId)}.json`);
}

export function attemptStatePath(taskDirectory: string, attemptId: string): string {
	return join(taskDirectory, "attempts", `${requireAttemptId(attemptId)}.json`);
}

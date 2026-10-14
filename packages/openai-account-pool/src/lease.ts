import { randomUUID } from "node:crypto";
import { readPoolState, withPoolStateTransaction, type EnrollmentLeaseRecord, type PoolStateFile } from "./store.ts";

/**
 * Membership changes hold a lease instead of the credential lock, because adding an account
 * waits for a browser. The lease keeps two pi processes from running wizards or an off at the
 * same time, and it expires so a crashed command recovers without manual cleanup.
 */

export const DEFAULT_ENROLLMENT_TTL_MS = 120_000;
const RENEW_SAFETY_MS = 5_000;

export class EnrollmentInProgressError extends Error {
	constructor(record: EnrollmentLeaseRecord) {
		super(`Another pi process is changing the openai-codex account pool (${record.purpose}, pid ${record.processId}). Finish or close it first.`);
		this.name = "EnrollmentInProgressError";
	}
}

export class EnrollmentLeaseLostError extends Error {
	constructor() {
		super("This pool operation lost its lease, so it must not change accounts. Run the command again.");
		this.name = "EnrollmentLeaseLostError";
	}
}

export interface EnrollmentLease {
	record: EnrollmentLeaseRecord;
	/** Extend while a long step such as a browser authorization is still running. */
	renew(): Promise<void>;
	release(): Promise<void>;
}

export function isProcessAlive(processId: number): boolean {
	if (!Number.isInteger(processId) || processId <= 0) return false;
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function activeEnrollment(state: PoolStateFile, now: number): EnrollmentLeaseRecord | undefined {
	const record = state.enrollment;
	if (!record) return undefined;
	if (record.expiresAtMs <= now) return undefined;
	if (record.processId !== process.pid && !isProcessAlive(record.processId)) return undefined;
	return record;
}

export async function assertNoActiveEnrollment(input: { statePath: string; now?: number }): Promise<void> {
	const record = activeEnrollment(await readPoolState(input.statePath), input.now ?? Date.now());
	if (record) throw new EnrollmentInProgressError(record);
}

export async function acquireEnrollmentLease(input: {
	statePath: string;
	purpose: string;
	ttlMs?: number;
	now?: () => number;
	signal?: AbortSignal;
}): Promise<EnrollmentLease> {
	const now = input.now ?? (() => Date.now());
	const ttlMs = input.ttlMs ?? DEFAULT_ENROLLMENT_TTL_MS;
	const owner = randomUUID();

	const record = await withPoolStateTransaction(input.statePath, (state) => {
		const held = activeEnrollment(state, now());
		if (held) throw new EnrollmentInProgressError(held);
		const mine: EnrollmentLeaseRecord = {
			owner,
			processId: process.pid,
			purpose: input.purpose,
			startedAtMs: now(),
			expiresAtMs: now() + ttlMs,
		};
		return { value: { ...state, enrollment: mine }, result: mine };
	}, { signal: input.signal });

	let current = record;
	let released = false;

	return {
		get record() {
			return current;
		},
		async renew() {
			if (released) throw new EnrollmentLeaseLostError();
			current = await withPoolStateTransaction(input.statePath, (state) => {
				if (state.enrollment?.owner !== owner) throw new EnrollmentLeaseLostError();
				const renewed: EnrollmentLeaseRecord = { ...state.enrollment, expiresAtMs: now() + ttlMs };
				return { value: { ...state, enrollment: renewed }, result: renewed };
			});
		},
		async release() {
			if (released) return;
			released = true;
			await withPoolStateTransaction(input.statePath, (state) => {
				// Only the holder clears it; a reclaimed lease now belongs to another process.
				if (state.enrollment?.owner !== owner) return { result: undefined };
				const next = { ...state };
				delete next.enrollment;
				return { value: next, result: undefined };
			});
		},
	};
}

/** Run one membership change under a lease, renewing it while the body is still working. */
export async function withEnrollmentLease<T>(
	input: { statePath: string; purpose: string; ttlMs?: number; signal?: AbortSignal },
	run: (lease: EnrollmentLease) => Promise<T>,
): Promise<T> {
	const lease = await acquireEnrollmentLease(input);
	const ttlMs = input.ttlMs ?? DEFAULT_ENROLLMENT_TTL_MS;
	const timer = setInterval(() => {
		void lease.renew().catch(() => { /* The next write fails visibly through assertHeld/renew. */ });
	}, Math.max(ttlMs - RENEW_SAFETY_MS, RENEW_SAFETY_MS));
	timer.unref?.();
	try {
		return await run(lease);
	} finally {
		clearInterval(timer);
		await lease.release();
	}
}

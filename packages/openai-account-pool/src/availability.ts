import type { PoolAccount } from "./auth.ts";
import { ACCOUNT_SCOPE, type AccountAvailability, type Classification } from "./policy.ts";
import {
	readPoolState,
	withPoolStateTransaction,
	type AccountCooldown,
	type AccountStateRecord,
	type AccountUsage,
	type PoolStateFile,
} from "./store.ts";

/**
 * Shared availability state. Every pi process using the same agent directory reads the same
 * cooldowns, so a limit one process hit is skipped by the next request anywhere.
 *
 * Two ordering rules keep concurrent requests honest: evidence recorded for an older account
 * generation is ignored after a re-authorization, and a success only clears evidence that was
 * recorded before that request started.
 */

/** Local backoff when the server stated no reset time. Not a claimed quota reset. */
export const DEFAULT_PROBE_BACKOFF_MS = 60_000;
export const DEFAULT_PROBE_LEASE_MS = 30_000;

function emptyRecord(): AccountStateRecord {
	return { cooldowns: {} };
}

function cooldownEndMs(cooldown: AccountCooldown): number {
	return Math.max(cooldown.serverResetAtMs ?? 0, cooldown.probeAfterMs ?? 0);
}

/** Cooldowns that still describe this account: same generation, and in scope for this request. */
function relevantCooldowns(record: AccountStateRecord | undefined, account: PoolAccount, modelId?: string): AccountCooldown[] {
	const scopes = modelId ? [ACCOUNT_SCOPE, `model:${modelId}`] : [ACCOUNT_SCOPE];
	return scopes
		.map((scope) => record?.cooldowns?.[scope])
		.filter((cooldown): cooldown is AccountCooldown => !!cooldown && cooldown.generation === account.generation);
}

export function availabilityFor(input: {
	accounts: readonly PoolAccount[];
	state: PoolStateFile;
	now: number;
	modelId?: string;
	/** This process's probe owner id, so its own lease does not block it. */
	probeOwner?: string;
}): AccountAvailability[] {
	return input.accounts.map((account) => {
		const record = input.state.accounts[account.id];
		const authInvalid = record?.authInvalidGeneration === account.generation;
		const cooldowns = relevantCooldowns(record, account, input.modelId);
		const active = cooldowns.filter((cooldown) => cooldownEndMs(cooldown) > input.now);
		if (active.length > 0) {
			const blocking = active.reduce((latest, cooldown) => (cooldownEndMs(cooldown) > cooldownEndMs(latest) ? cooldown : latest));
			return {
				id: account.id,
				ordinal: account.ordinal,
				authInvalid,
				needsProbe: false,
				unavailable: { reason: blocking.reason, untilMs: cooldownEndMs(blocking), serverResetAtMs: blocking.serverResetAtMs },
			};
		}
		const needsProbe = cooldowns.length > 0;
		const lease = record?.probeLease;
		if (lease && lease.untilMs > input.now && lease.owner !== input.probeOwner) {
			// Another process is already testing whether this account recovered.
			return {
				id: account.id,
				ordinal: account.ordinal,
				authInvalid,
				needsProbe: true,
				unavailable: { reason: "probe_in_progress", untilMs: lease.untilMs, serverResetAtMs: null },
			};
		}
		return { id: account.id, ordinal: account.ordinal, authInvalid, needsProbe };
	});
}

export async function readAvailability(input: {
	statePath: string;
	accounts: readonly PoolAccount[];
	now: number;
	modelId?: string;
	probeOwner?: string;
}): Promise<AccountAvailability[]> {
	return availabilityFor({ ...input, state: await readPoolState(input.statePath) });
}

export async function readPreferredAccountId(statePath: string): Promise<string | undefined> {
	return (await readPoolState(statePath)).preferredAccountId;
}

/** Sets the account future sessions start from, or clears the preference with `undefined`. */
export async function setPreferredAccountId(input: { statePath: string; accountId: string | undefined }): Promise<void> {
	await withPoolStateTransaction(input.statePath, (state) => {
		if (state.preferredAccountId === input.accountId) return { result: undefined };
		const next = { ...state };
		if (input.accountId === undefined) delete next.preferredAccountId;
		else next.preferredAccountId = input.accountId;
		return { value: next, result: undefined };
	});
}

/**
 * Stores the quota a response reported. The newest observation wins, so a slow write cannot
 * replace a fresher reading with a stale one. No generation guard: quota belongs to the ChatGPT
 * account itself and survives re-authorization, unlike the credential.
 */
export async function recordUsage(input: {
	statePath: string;
	account: PoolAccount;
	usage: AccountUsage;
	/** An available live observation disproves only quota evidence no newer than itself. */
	clearQuotaCooldowns?: boolean;
}): Promise<boolean> {
	return withPoolStateTransaction(input.statePath, (state) => {
		const existing = state.accounts[input.account.id];
		if ((existing?.usage?.observedAtMs ?? 0) >= input.usage.observedAtMs) return { result: false };
		const record: AccountStateRecord = { ...(existing ?? emptyRecord()), usage: input.usage };
		if (input.clearQuotaCooldowns) {
			record.cooldowns = Object.fromEntries(
				Object.entries(record.cooldowns ?? {}).filter(
					([, cooldown]) =>
						cooldown.generation !== input.account.generation || cooldown.recordedAtMs > input.usage.observedAtMs,
				),
			);
		}
		return { value: { ...state, accounts: { ...state.accounts, [input.account.id]: record } }, result: true };
	});
}

export async function recordFailure(input: {
	statePath: string;
	account: PoolAccount;
	classification: Classification;
	now: number;
	probeBackoffMs?: number;
}): Promise<void> {
	const { classification, account, now } = input;
	if (classification.kind !== "quota" && classification.kind !== "auth_invalid") return;
	await withPoolStateTransaction(input.statePath, (state) => {
		const record: AccountStateRecord = { ...(state.accounts[account.id] ?? emptyRecord()) };
		record.cooldowns = { ...record.cooldowns };
		if (classification.kind === "auth_invalid") {
			record.authInvalidGeneration = account.generation;
			record.authInvalidAtMs = now;
		} else {
			const existing = record.cooldowns[classification.scope];
			// Evidence from an older generation must not outrank a newer login.
			if (existing && existing.generation > account.generation) return { result: undefined };
			record.cooldowns[classification.scope] = {
				reason: classification.reason,
				generation: account.generation,
				serverResetAtMs: classification.serverResetAtMs,
				// Without a server reset time, only a short local backoff before probing again.
				probeAfterMs: classification.serverResetAtMs === null ? now + (input.probeBackoffMs ?? DEFAULT_PROBE_BACKOFF_MS) : null,
				recordedAtMs: now,
			};
		}
		delete record.probeLease;
		return { value: { ...state, accounts: { ...state.accounts, [account.id]: record } }, result: undefined };
	});
}

/** Clear only the evidence that predates this request, so a slow success cannot undo a new limit. */
export async function recordSuccess(input: {
	statePath: string;
	account: PoolAccount;
	requestStartedAtMs: number;
	clearEvidence?: boolean;
}): Promise<void> {
	await withPoolStateTransaction(input.statePath, (state) => {
		const record = state.accounts[input.account.id];
		if (!record || input.clearEvidence === false) {
			return { value: { ...state, currentAccountId: input.account.id }, result: undefined };
		}
		const cooldowns: Record<string, AccountCooldown> = {};
		for (const [scope, cooldown] of Object.entries(record.cooldowns ?? {})) {
			const stale = cooldown.generation !== input.account.generation;
			if (!stale && cooldown.recordedAtMs > input.requestStartedAtMs) cooldowns[scope] = cooldown;
		}
		// Usage is an observation, not evidence of failure, so success does not invalidate it.
		const next: AccountStateRecord = { cooldowns, ...(record.usage ? { usage: record.usage } : {}) };
		if (record.authInvalidGeneration === input.account.generation && (record.authInvalidAtMs ?? 0) > input.requestStartedAtMs) {
			next.authInvalidGeneration = record.authInvalidGeneration;
			next.authInvalidAtMs = record.authInvalidAtMs;
		}
		return { value: { ...state, currentAccountId: input.account.id, accounts: { ...state.accounts, [input.account.id]: next } }, result: undefined };
	});
}

/** Bounded lease so a recovered account is probed by one process, not by all of them. */
export async function claimProbeLease(input: {
	statePath: string;
	accountId: string;
	owner: string;
	now: number;
	ttlMs?: number;
}): Promise<boolean> {
	return withPoolStateTransaction(input.statePath, (state) => {
		const record: AccountStateRecord = { ...(state.accounts[input.accountId] ?? emptyRecord()) };
		const lease = record.probeLease;
		if (lease && lease.untilMs > input.now && lease.owner !== input.owner) return { result: false };
		record.probeLease = { owner: input.owner, untilMs: input.now + (input.ttlMs ?? DEFAULT_PROBE_LEASE_MS) };
		return { value: { ...state, accounts: { ...state.accounts, [input.accountId]: record } }, result: true };
	});
}

export async function releaseProbeLease(input: { statePath: string; accountId: string; owner: string }): Promise<void> {
	await withPoolStateTransaction(input.statePath, (state) => {
		const record = state.accounts[input.accountId];
		if (record?.probeLease?.owner !== input.owner) return { result: undefined };
		const next = { ...record };
		delete next.probeLease;
		return { value: { ...state, accounts: { ...state.accounts, [input.accountId]: next } }, result: undefined };
	});
}

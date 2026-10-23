import {
	isPoolEntryKey,
	MAIN_PROVIDER_ID,
	poolEntryKey,
	readAuthEntries,
	withAuthTransaction,
	type AuthEntries,
	type AuthEntry,
} from "./store.ts";

/**
 * Credential ownership for the pool.
 *
 * `auth.json` stays the single authority. When the pool is enabled the `openai-codex` entry
 * holds an explicitly marked, non-secret reference, and every real OAuth credential lives in
 * its own account entry. One transaction writes both, so adding an account can never drop
 * another one the way a second plain `/login` does.
 */

/** Placeholders, never a token. The Codex API rejects them because they carry no account claim. */
export const POOL_REFERENCE_TOKEN = "pi-openai-account-pool:reference-not-a-token";
/** Request auth the wrapped provider must replace with a selected account before sending. */
export const POOL_UNRESOLVED_API_KEY = "pi-openai-account-pool:unresolved-account";
const POOL_REFERENCE_FIELD = "piOpenAIAccountPool";
/** Non-secret membership data on each account entry, so the reference can be rebuilt from the file. */
const POOL_MEMBERSHIP_FIELD = "piOpenAIAccountPoolMembership";
/** Far future so pre-request resolution never tries to refresh the reference itself. */
const POOL_REFERENCE_EXPIRES_MS = Date.UTC(2100, 0, 1);
const JWT_ACCOUNT_CLAIM = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";
const MAX_EMAIL_LENGTH = 254;
const DEFAULT_MIN_VALIDITY_MS = 5 * 60_000;

/** Non-secret identity claims, so two subscriptions can be told apart by name. */
export interface AccountProfile {
	/** ChatGPT sign-in address from the token's profile or root email claim. */
	email?: string;
	/** Subscription tier claim, e.g. `plus` or `pro`. */
	plan?: string;
}

export interface PoolAccount extends AccountProfile {
	id: string;
	/** Storage key of this account's real credential. */
	key: string;
	/** Stable display number; never reused after a removal. */
	ordinal: number;
	addedAt: number;
	generation: number;
}

export interface PoolReference {
	v: 1;
	/** Bumped on every add, update and removal. */
	generation: number;
	accounts: PoolAccount[];
}

export class ExistingLoginNotIdentifiableError extends Error {
	constructor() {
		super("The stored openai-codex login has no account id, so it cannot be kept as a pool account. Sign in again to replace it.");
		this.name = "ExistingLoginNotIdentifiableError";
	}
}

export class PoolNotEnabledError extends Error {
	constructor() {
		super("The openai-codex account pool is not enabled.");
		this.name = "PoolNotEnabledError";
	}
}

export class PoolAccountMissingError extends Error {
	constructor(accountId: string) {
		super(`No stored credential for pool account ${maskAccountId(accountId)}. Re-authorize it.`);
		this.name = "PoolAccountMissingError";
	}
}

export function maskAccountId(accountId: string): string {
	return accountId.length <= 4 ? "…" : `…${accountId.slice(-4)}`;
}

/** What the user sees: the sign-in address when the token carries it, else the masked id. */
export function accountLabel(account: PoolAccount): string {
	return `#${account.ordinal} (${account.email ?? maskAccountId(account.id)})`;
}

export function isOAuthEntry(entry: AuthEntry | undefined): boolean {
	return (
		!!entry &&
		entry.type === "oauth" &&
		typeof entry.access === "string" &&
		typeof entry.refresh === "string" &&
		typeof entry.expires === "number" &&
		Number.isFinite(entry.expires)
	);
}

function accessTokenClaims(entry: AuthEntry | undefined): Record<string, unknown> | undefined {
	if (typeof entry?.access !== "string") return undefined;
	const segments = entry.access.split(".");
	if (segments.length !== 3) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as unknown;
		return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** Account id from the stored field, falling back to the access token's account claim. */
export function accountIdOf(entry: AuthEntry | undefined): string | undefined {
	if (!entry) return undefined;
	if (typeof entry.accountId === "string" && entry.accountId.length > 0) return entry.accountId;
	const claim = accessTokenClaims(entry)?.[JWT_ACCOUNT_CLAIM] as { chatgpt_account_id?: unknown } | undefined;
	return typeof claim?.chatgpt_account_id === "string" && claim.chatgpt_account_id.length > 0 ? claim.chatgpt_account_id : undefined;
}

/** Keeps anything unexpected out of the labels the user reads. */
function sanitizeProfile(profile: { email?: unknown; plan?: unknown }): AccountProfile {
	const email = typeof profile.email === "string" ? profile.email.trim() : "";
	const plan = typeof profile.plan === "string" ? profile.plan.trim() : "";
	return {
		email: email.length <= MAX_EMAIL_LENGTH && /^[^\s@"]+@[^\s@"]+\.[^\s@"]+$/.test(email) ? email : undefined,
		plan: /^[a-z0-9_-]{1,32}$/i.test(plan) ? plan : undefined,
	};
}

/** Identity claims of a stored credential. None of these is usable as a credential itself. */
export function accountProfileOf(entry: AuthEntry | undefined): AccountProfile {
	const claims = accessTokenClaims(entry);
	const profile = claims?.[JWT_PROFILE_CLAIM] as { email?: unknown } | undefined;
	const auth = claims?.[JWT_ACCOUNT_CLAIM] as { chatgpt_plan_type?: unknown } | undefined;
	const sanitized = sanitizeProfile({ email: profile?.email, plan: auth?.chatgpt_plan_type });
	return { ...sanitized, email: sanitized.email ?? sanitizeProfile({ email: claims?.email }).email };
}

/** The token is the fresher source, so a rotated credential updates a stored label. */
function withAccountProfile(account: PoolAccount, entry: AuthEntry | undefined): PoolAccount {
	const profile = accountProfileOf(entry);
	return { ...account, email: profile.email ?? account.email, plan: profile.plan ?? account.plan };
}

export function readPoolReference(entry: AuthEntry | undefined): PoolReference | undefined {
	const raw = entry?.[POOL_REFERENCE_FIELD] as Partial<PoolReference> | undefined;
	if (!raw || raw.v !== 1 || typeof raw.generation !== "number" || !Array.isArray(raw.accounts)) return undefined;
	const accounts: PoolAccount[] = [];
	for (const candidate of raw.accounts as Partial<PoolAccount>[]) {
		if (
			typeof candidate?.id !== "string" ||
			typeof candidate.key !== "string" ||
			typeof candidate.ordinal !== "number" ||
			typeof candidate.addedAt !== "number" ||
			typeof candidate.generation !== "number"
		) {
			return undefined;
		}
		accounts.push({
			id: candidate.id,
			key: candidate.key,
			ordinal: candidate.ordinal,
			addedAt: candidate.addedAt,
			generation: candidate.generation,
			...sanitizeProfile(candidate),
		});
	}
	return { v: 1, generation: raw.generation, accounts };
}

export function isPoolReferenceEntry(entry: AuthEntry | undefined): boolean {
	return readPoolReference(entry) !== undefined;
}

interface AccountMembership {
	ordinal: number;
	addedAt: number;
}

function readMembership(entry: AuthEntry | undefined): AccountMembership | undefined {
	const raw = entry?.[POOL_MEMBERSHIP_FIELD] as Partial<AccountMembership> | undefined;
	if (!raw || typeof raw.ordinal !== "number" || typeof raw.addedAt !== "number") return undefined;
	return { ordinal: raw.ordinal, addedAt: raw.addedAt };
}

function withMembership(credential: AuthEntry, membership: AccountMembership): AuthEntry {
	return { ...accountCredential(credential), [POOL_MEMBERSHIP_FIELD]: membership };
}

/** The credential alone, so a restored plain login carries no pool bookkeeping. */
export function accountCredential(entry: AuthEntry): AuthEntry {
	const credential = { ...entry };
	delete credential[POOL_MEMBERSHIP_FIELD];
	return credential;
}

/**
 * Accounts stored under the pool prefix that the main entry no longer references, which is what
 * a plain `/login` or `/logout` leaves behind. They are re-adopted explicitly and reported, never
 * silently resurrected as an extra quota source.
 */
function findOrphanedAccounts(entries: AuthEntries, known: PoolAccount[]): PoolAccount[] {
	const knownKeys = new Set(known.map((account) => account.key));
	const orphans: PoolAccount[] = [];
	for (const [key, entry] of Object.entries(entries)) {
		if (!isPoolEntryKey(key) || knownKeys.has(key) || !isOAuthEntry(entry)) continue;
		const id = accountIdOf(entry);
		const membership = readMembership(entry);
		// A key that does not match its own account id is not trustworthy membership data.
		if (!id || !membership || poolEntryKey(id) !== key) continue;
		orphans.push({ id, key, ordinal: membership.ordinal, addedAt: membership.addedAt, generation: 0 });
	}
	return orphans.sort((left, right) => left.ordinal - right.ordinal);
}

export function buildPoolReferenceEntry(reference: PoolReference): AuthEntry {
	return {
		type: "oauth",
		access: POOL_REFERENCE_TOKEN,
		refresh: POOL_REFERENCE_TOKEN,
		expires: POOL_REFERENCE_EXPIRES_MS,
		[POOL_REFERENCE_FIELD]: reference,
	};
}

export interface PoolSnapshot {
	enabled: boolean;
	generation: number;
	accounts: PoolAccount[];
	/** True when the main entry holds a real credential, i.e. plain single-account login. */
	nativeLoginPresent: boolean;
	/** True when nothing is stored for openai-codex at all. */
	loggedOut: boolean;
}

export function poolSnapshotFromEntries(entries: AuthEntries): PoolSnapshot {
	const main = entries[MAIN_PROVIDER_ID];
	const reference = readPoolReference(main);
	if (reference) {
		const accounts = reference.accounts.map((account) => withAccountProfile(account, entries[account.key]));
		return { enabled: true, generation: reference.generation, accounts, nativeLoginPresent: false, loggedOut: false };
	}
	return {
		enabled: false,
		generation: 0,
		accounts: [],
		nativeLoginPresent: main !== undefined,
		loggedOut: main === undefined,
	};
}

export async function loadPoolSnapshot(authPath: string): Promise<PoolSnapshot> {
	return poolSnapshotFromEntries(await readAuthEntries(authPath));
}

export interface CommitAccountResult {
	outcome: "added" | "updated";
	account: PoolAccount;
	accountCount: number;
	/** True when an existing plain login was kept as a pool account by this commit. */
	migratedExistingLogin: boolean;
	/** Previously stored accounts this commit brought back under the pool reference. */
	readoptedAccounts: number;
	generation: number;
}

/**
 * Store one freshly authorized credential and publish the pool reference in the same atomic
 * write. The first successful commit also keeps the existing plain login as an account, which
 * is how the pool turns on without a separate setup step.
 */
export async function commitAccount(input: {
	authPath: string;
	credential: AuthEntry;
	now?: number;
	signal?: AbortSignal;
}): Promise<CommitAccountResult> {
	if (!isOAuthEntry(input.credential)) throw new Error("Refusing to store a credential that is not an OAuth credential.");
	const accountId = accountIdOf(input.credential);
	if (!accountId) throw new Error("The login returned no account id; refusing to store an unidentifiable account.");
	const now = input.now ?? Date.now();

	return withAuthTransaction(input.authPath, (entries) => {
		const main = entries[MAIN_PROVIDER_ID];
		const reference = readPoolReference(main);
		const generation = (reference?.generation ?? 0) + 1;
		const accounts = reference ? [...reference.accounts] : [];
		const next: AuthEntries = { ...entries };
		let migratedExistingLogin = false;

		// Without a reference, a real credential in the main entry is the user's plain login.
		if (!reference && isOAuthEntry(main)) {
			const existingId = accountIdOf(main);
			if (!existingId) throw new ExistingLoginNotIdentifiableError();
			migratedExistingLogin = true;
			if (existingId !== accountId) {
				const key = poolEntryKey(existingId);
				const membership = readMembership(entries[key]) ?? { ordinal: 1, addedAt: now };
				const kept: PoolAccount = { id: existingId, key, ordinal: membership.ordinal, addedAt: membership.addedAt, generation };
				accounts.push(withAccountProfile(kept, main));
				next[key] = withMembership(main as AuthEntry, membership);
			}
		}

		const readopted = findOrphanedAccounts(next, accounts).filter((orphan) => orphan.id !== accountId);
		for (const orphan of readopted) accounts.push(withAccountProfile({ ...orphan, generation }, next[orphan.key]));
		accounts.sort((left, right) => left.ordinal - right.ordinal);

		const existingIndex = accounts.findIndex((candidate) => candidate.id === accountId);
		let account: PoolAccount;
		let outcome: CommitAccountResult["outcome"];
		if (existingIndex >= 0) {
			// A second login with the same account refreshes its credential and label in place.
			account = withAccountProfile({ ...accounts[existingIndex], generation }, input.credential);
			accounts[existingIndex] = account;
			outcome = "updated";
		} else {
			const key = poolEntryKey(accountId);
			// Reuse the display number of an account that was stored before, so status stays stable.
			const membership = readMembership(entries[key]);
			const ordinal = membership?.ordinal ?? accounts.reduce((highest, candidate) => Math.max(highest, candidate.ordinal), 0) + 1;
			account = withAccountProfile({ id: accountId, key, ordinal, addedAt: membership?.addedAt ?? now, generation }, input.credential);
			accounts.push(account);
			outcome = "added";
		}

		next[account.key] = withMembership({ ...input.credential }, { ordinal: account.ordinal, addedAt: account.addedAt });
		next[MAIN_PROVIDER_ID] = buildPoolReferenceEntry({ v: 1, generation, accounts });
		return {
			value: next,
			result: { outcome, account, accountCount: accounts.length, migratedExistingLogin, readoptedAccounts: readopted.length, generation },
		};
	}, { signal: input.signal });
}

/** Restore one account as the plain `openai-codex` login and give up the pool's authority over it. */
export async function disablePool(input: { authPath: string; accountId: string; signal?: AbortSignal }): Promise<{ restored: PoolAccount; dormantAccounts: number }> {
	return withAuthTransaction(input.authPath, (entries) => {
		const reference = readPoolReference(entries[MAIN_PROVIDER_ID]);
		if (!reference) throw new PoolNotEnabledError();
		const account = reference.accounts.find((candidate) => candidate.id === input.accountId);
		if (!account) throw new PoolAccountMissingError(input.accountId);
		const credential = entries[account.key];
		if (!isOAuthEntry(credential)) throw new PoolAccountMissingError(input.accountId);
		const next: AuthEntries = { ...entries };
		// One refresh authority after off: the restored account exists only in the main entry.
		delete next[account.key];
		next[MAIN_PROVIDER_ID] = accountCredential(credential);
		return { value: next, result: { restored: account, dormantAccounts: reference.accounts.length - 1 } };
	}, { signal: input.signal });
}

export interface PoolReferenceCleanup {
	/** References whose credentials were already removed outside the pool. */
	pruned: PoolAccount[];
	remaining: number;
	poolDisabled: boolean;
}

/**
 * Native /logout can remove an account entry without updating our main reference. Only prune
 * absent credentials; expired or malformed credentials are not proof that the user deleted them.
 */
export async function pruneMissingPoolAccounts(input: { authPath: string; signal?: AbortSignal }): Promise<PoolReferenceCleanup | undefined> {
	return withAuthTransaction(input.authPath, (entries) => {
		const reference = readPoolReference(entries[MAIN_PROVIDER_ID]);
		if (!reference) return { result: undefined };
		const pruned = reference.accounts.filter((account) => entries[account.key] === undefined);
		if (pruned.length === 0 && reference.accounts.length > 0) return { result: undefined };
		const remaining = reference.accounts.filter((account) => entries[account.key] !== undefined);
		const next = { ...entries };
		if (remaining.length === 0) delete next[MAIN_PROVIDER_ID];
		else next[MAIN_PROVIDER_ID] = buildPoolReferenceEntry({ v: 1, generation: reference.generation + 1, accounts: remaining });
		return { value: next, result: { pruned, remaining: remaining.length, poolDisabled: remaining.length === 0 } };
	}, { signal: input.signal });
}

/** Delete one account's local credential. Removing the last real one also clears stale references. */
export async function removeAccount(input: { authPath: string; accountId: string; signal?: AbortSignal }): Promise<PoolReferenceCleanup & { removed: PoolAccount }> {
	return withAuthTransaction(input.authPath, (entries) => {
		const reference = readPoolReference(entries[MAIN_PROVIDER_ID]);
		if (!reference) throw new PoolNotEnabledError();
		const account = reference.accounts.find((candidate) => candidate.id === input.accountId);
		if (!account) throw new PoolAccountMissingError(input.accountId);
		const others = reference.accounts.filter((candidate) => candidate.id !== input.accountId);
		const pruned = others.filter((candidate) => entries[candidate.key] === undefined);
		const remaining = others.filter((candidate) => entries[candidate.key] !== undefined);
		const next: AuthEntries = { ...entries };
		delete next[account.key];
		if (remaining.length === 0) delete next[MAIN_PROVIDER_ID];
		else next[MAIN_PROVIDER_ID] = buildPoolReferenceEntry({ v: 1, generation: reference.generation + 1, accounts: remaining });
		return { value: next, result: { removed: account, pruned, remaining: remaining.length, poolDisabled: remaining.length === 0 } };
	}, { signal: input.signal });
}

export interface FreshCredential {
	credential: AuthEntry;
	refreshed: boolean;
}

/**
 * Resolve one account's usable credential, refreshing under the lock with the same
 * double-checked pattern pi uses: another process may have rotated the token already, and a
 * refresh that started must persist even when the request that triggered it is cancelled.
 */
export async function ensureFreshAccountCredential(input: {
	authPath: string;
	account: PoolAccount;
	refresh: (credential: AuthEntry) => Promise<AuthEntry>;
	minValidityMs?: number;
	now?: () => number;
	signal?: AbortSignal;
	/** Rotate even when the stored credential still looks valid, after the server rejected it. */
	force?: boolean;
	/** The access token that was rejected; a credential someone else already rotated is taken as is. */
	staleAccess?: string;
}): Promise<FreshCredential> {
	const minValidityMs = input.minValidityMs ?? DEFAULT_MIN_VALIDITY_MS;
	const now = input.now ?? (() => Date.now());
	const usable = (entry: AuthEntry) => Number(entry.expires) - now() > minValidityMs;

	if (!input.force) {
		// Optimistic read outside the lock, like pi's own resolution.
		const current = (await readAuthEntries(input.authPath))[input.account.key];
		if (isOAuthEntry(current) && usable(current)) return { credential: accountCredential(current), refreshed: false };
	}

	return withAuthTransaction(input.authPath, async (entries) => {
		const stored = entries[input.account.key];
		if (!isOAuthEntry(stored)) throw new PoolAccountMissingError(input.account.id);
		// Another request may have rotated the rejected token while this one waited for the lock.
		if (input.force && input.staleAccess !== undefined && stored.access !== input.staleAccess) {
			return { result: { credential: accountCredential(stored), refreshed: false } };
		}
		if (!input.force && usable(stored)) return { result: { credential: accountCredential(stored), refreshed: false } };
		const refreshed = await input.refresh(accountCredential(stored));
		if (!isOAuthEntry(refreshed)) throw new Error("OAuth refresh returned an invalid credential.");
		// Keep the account identity even if the provider omits it when rotating.
		const rotated: AuthEntry = { ...accountCredential(refreshed), accountId: accountIdOf(refreshed) ?? input.account.id };
		const membership = readMembership(stored) ?? { ordinal: input.account.ordinal, addedAt: input.account.addedAt };
		return {
			value: { ...entries, [input.account.key]: withMembership(rotated, membership) },
			result: { credential: rotated, refreshed: true },
		};
	}, { signal: input.signal });
}

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { acquireFileLock, type FileLockOptions } from "./lock.ts";

/** The model provider the pool serves. Requests keep using `openai-codex/<model>`. */
export const MAIN_PROVIDER_ID = "openai-codex";
/** Prefix of the per-account storage keys. These are credential-store keys, not providers. */
export const POOL_ENTRY_PREFIX = "pi-openai-account-pool/";
export const STATE_DIRECTORY_NAME = "openai-account-pool";
export const STATE_SCHEMA_VERSION = 1;

export type AuthEntry = Record<string, unknown>;
export type AuthEntries = Record<string, AuthEntry>;

export interface TransactionResult<TValue, TResult> {
	/** Returned only to write; omit it to leave the file untouched. */
	value?: TValue;
	result: TResult;
}

export function authPathFor(agentDir: string): string {
	return join(agentDir, "auth.json");
}

export function poolStatePathFor(agentDir: string): string {
	return join(agentDir, STATE_DIRECTORY_NAME, "state.json");
}

/** Stable storage key for one account, derived from the provider's own account id. */
export function poolEntryKey(accountId: string): string {
	return `${POOL_ENTRY_PREFIX}${createHash("sha256").update(accountId).digest("hex").slice(0, 16)}`;
}

export function isPoolEntryKey(key: string): boolean {
	return key.startsWith(POOL_ENTRY_PREFIX);
}

function parseAuthEntries(text: string, path: string): AuthEntries {
	const content = text.replace(/^\uFEFF/, "");
	if (content.trim() === "") return {};
	const parsed = JSON.parse(content) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid ${path}: expected a JSON object.`);
	}
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`Invalid ${path}: credential "${key}" is not an object.`);
		}
	}
	return parsed as AuthEntries;
}

export async function readAuthEntries(authPath: string): Promise<AuthEntries> {
	let text: string;
	try { text = await readFile(authPath, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	return parseAuthEntries(text, authPath);
}

/** Replacing a symlink or a non-file would write outside the agent directory or corrupt state. */
async function assertReplaceableFile(path: string): Promise<void> {
	let identity;
	try { identity = await lstat(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!identity.isFile()) throw new Error(`Refusing to replace ${path}: it is not a regular file.`);
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(text, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try { await rename(temporary, path); }
	catch (error) {
		await unlink(temporary).catch(() => {});
		throw error;
	}
}

/**
 * Read-modify-write of `auth.json` under the lock pi uses. Returning `value` replaces the whole
 * file in one atomic rename, which is what lets one transaction add an account and update the
 * main entry together. Unrelated provider entries must be carried over by the caller.
 */
export async function withAuthTransaction<T>(
	authPath: string,
	run: (entries: AuthEntries) => Promise<TransactionResult<AuthEntries, T>> | TransactionResult<AuthEntries, T>,
	options: FileLockOptions = {},
): Promise<T> {
	await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
	const lock = await acquireFileLock(authPath, options);
	try {
		await assertReplaceableFile(authPath);
		const { value, result } = await run(await readAuthEntries(authPath));
		if (value !== undefined) {
			await lock.verifyHeld();
			// Match pi's own formatting so concurrent writers produce comparable files.
			await writeTextAtomic(authPath, JSON.stringify(value, null, 2));
		}
		return result;
	} finally {
		await lock.release();
	}
}

/** Why an account is unavailable right now. Non-secret; shared across pi processes. */
export interface AccountCooldown {
	reason: string;
	/** Pool generation this evidence belongs to; older evidence never outranks a newer login. */
	generation: number;
	/** Server-stated reset time in epoch ms, or null when the server did not state one. */
	serverResetAtMs: number | null;
	/** Local backoff before the next probe. Not a claimed quota reset time. */
	probeAfterMs: number | null;
	recordedAtMs: number;
}

/** One server-reported quota window. Non-secret: a percentage is not a credential. */
export interface UsageWindow {
	usedPercent: number;
	/** Window length the server reported, which is what tells the five-hour one from the weekly one. */
	windowSeconds?: number;
	/** Server-stated reset time in epoch ms. Absent when the server stated none. */
	resetAtMs?: number;
}

/** Quota as of the last successful wham/usage lookup for this account. */
export interface AccountUsage {
	/** Codex's primary window, the rolling five-hour one. */
	primary?: UsageWindow;
	/** Codex's secondary window, the weekly one. */
	secondary?: UsageWindow;
	/** Explicit backend decision, when returned by wham/usage. */
	allowed?: boolean;
	limitReached?: boolean;
	plan?: string;
	observedAtMs: number;
}

export interface AccountStateRecord {
	/** Keyed by cooldown scope: "account" or `model:<id>`. */
	cooldowns: Record<string, AccountCooldown>;
	/** Last live usage observation, so a used-up account can still state its reset. */
	usage?: AccountUsage;
	/** Generation whose credential was proven invalid; re-authorizing bumps past it. */
	authInvalidGeneration?: number;
	/** When that proof was recorded, so an older request's success cannot clear it. */
	authInvalidAtMs?: number;
	/** Bounded lease so only one process probes a recovered account. */
	probeLease?: { owner: string; untilMs: number };
}

/** Who is currently changing pool membership. Keeps enrollment, off and removal exclusive. */
export interface EnrollmentLeaseRecord {
	owner: string;
	processId: number;
	purpose: string;
	startedAtMs: number;
	expiresAtMs: number;
}

export interface PoolStateFile {
	schemaVersion: number;
	policy: "sticky";
	accounts: Record<string, AccountStateRecord>;
	/** Global preference sampled by each new session; changes do not reroute running sessions. */
	preferredAccountId?: string;
	/** Account that most recently completed a model request successfully. */
	currentAccountId?: string;
	enrollment?: EnrollmentLeaseRecord;
}

export function emptyPoolState(): PoolStateFile {
	return { schemaVersion: STATE_SCHEMA_VERSION, policy: "sticky", accounts: {} };
}

function parsePoolState(text: string, path: string): PoolStateFile {
	const content = text.replace(/^\uFEFF/, "");
	if (content.trim() === "") return emptyPoolState();
	const parsed = JSON.parse(content) as Partial<PoolStateFile> | null;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid ${path}: expected a JSON object.`);
	}
	if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
		throw new Error(`Unsupported ${path}: schemaVersion ${String(parsed.schemaVersion)} is not ${STATE_SCHEMA_VERSION}.`);
	}
	if (typeof parsed.accounts !== "object" || parsed.accounts === null || Array.isArray(parsed.accounts)) {
		throw new Error(`Invalid ${path}: "accounts" must be an object.`);
	}
	const state: PoolStateFile = { schemaVersion: STATE_SCHEMA_VERSION, policy: "sticky", accounts: parsed.accounts as Record<string, AccountStateRecord> };
	if (parsed.preferredAccountId !== undefined) {
		if (typeof parsed.preferredAccountId !== "string" || parsed.preferredAccountId === "") {
			throw new Error(`Invalid ${path}: "preferredAccountId" must be a non-empty string.`);
		}
		state.preferredAccountId = parsed.preferredAccountId;
	}
	if (parsed.currentAccountId !== undefined) {
		if (typeof parsed.currentAccountId !== "string" || parsed.currentAccountId === "") {
			throw new Error(`Invalid ${path}: "currentAccountId" must be a non-empty string.`);
		}
		state.currentAccountId = parsed.currentAccountId;
	}
	const enrollment = parsed.enrollment;
	if (enrollment) {
		if (
			typeof enrollment.owner !== "string" ||
			typeof enrollment.processId !== "number" ||
			typeof enrollment.purpose !== "string" ||
			typeof enrollment.expiresAtMs !== "number" ||
			typeof enrollment.startedAtMs !== "number"
		) {
			throw new Error(`Invalid ${path}: "enrollment" is malformed.`);
		}
		state.enrollment = enrollment;
	}
	return state;
}

export async function readPoolState(statePath: string): Promise<PoolStateFile> {
	let text: string;
	try { text = await readFile(statePath, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyPoolState();
		throw error;
	}
	return parsePoolState(text, statePath);
}

/** Short transaction for the non-secret cooldown/probe state. Never holds across a model stream. */
export async function withPoolStateTransaction<T>(
	statePath: string,
	run: (state: PoolStateFile) => Promise<TransactionResult<PoolStateFile, T>> | TransactionResult<PoolStateFile, T>,
	options: FileLockOptions = {},
): Promise<T> {
	await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
	const lock = await acquireFileLock(statePath, options);
	try {
		await assertReplaceableFile(statePath);
		const { value, result } = await run(await readPoolState(statePath));
		if (value !== undefined) {
			await lock.verifyHeld();
			await writeTextAtomic(statePath, `${JSON.stringify(value, null, 2)}\n`);
		}
		return result;
	} finally {
		await lock.release();
	}
}

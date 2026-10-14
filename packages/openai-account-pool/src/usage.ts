import { accountLabel, ensureFreshAccountCredential, type PoolAccount } from "./auth.ts";
import { recordUsage } from "./availability.ts";
import type { AccountStateRecord, AccountUsage, PoolStateFile, UsageWindow } from "./store.ts";

/** ChatGPT's read-only Codex quota endpoint. Private and not guaranteed stable. */
export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

const MAX_RESET_HORIZON_MS = 30 * 24 * 60 * 60 * 1_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_USAGE_BODY_BYTES = 256 * 1024;
const DEFAULT_USAGE_TIMEOUT_MS = 10_000;
const EXHAUSTED_PERCENT = 100;
const MILLISECOND_EPOCH_FLOOR = 1e10;

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resetAtMs(raw: number | undefined, now: number): number | undefined {
	if (raw === undefined || raw <= 0) return undefined;
	const candidate = raw > MILLISECOND_EPOCH_FLOOR ? raw : raw * 1_000;
	return candidate > now - ONE_DAY_MS && candidate < now + MAX_RESET_HORIZON_MS ? candidate : undefined;
}

function normalizeWindow(value: unknown, now: number): UsageWindow | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const used = finite(raw.used_percent) ?? finite(raw.usedPercent);
	if (used === undefined) return undefined;
	const seconds = finite(raw.limit_window_seconds) ?? finite(raw.window_seconds) ?? finite(raw.windowSeconds);
	const minutes = finite(raw.window_minutes) ?? finite(raw.windowMinutes);
	const reset = resetAtMs(finite(raw.reset_at) ?? finite(raw.resetAt), now);
	return {
		usedPercent: Math.max(0, Math.min(100, used)),
		...(seconds !== undefined && seconds > 0
			? { windowSeconds: Math.round(seconds) }
			: minutes !== undefined && minutes > 0
				? { windowSeconds: Math.round(minutes * 60) }
				: {}),
		...(reset !== undefined ? { resetAtMs: reset } : {}),
	};
}

/** Normalizes one wham/usage response into the non-secret state we persist. */
export function normalizeUsageResponse(value: unknown, now: number): AccountUsage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Codex usage response is not an object.");
	const raw = value as Record<string, unknown>;
	const rateLimit = typeof raw.rate_limit === "object" && raw.rate_limit !== null ? (raw.rate_limit as Record<string, unknown>) : undefined;
	if (!rateLimit) throw new Error("Codex usage response has no rate_limit object.");
	const primary = normalizeWindow(rateLimit.primary_window, now);
	const secondary = normalizeWindow(rateLimit.secondary_window, now);
	const allowed = typeof rateLimit.allowed === "boolean" ? rateLimit.allowed : undefined;
	const limitReached = typeof rateLimit.limit_reached === "boolean" ? rateLimit.limit_reached : undefined;
	const plan = typeof raw.plan_type === "string" && /^[a-z0-9_-]{1,32}$/i.test(raw.plan_type) ? raw.plan_type : undefined;
	if (!primary && !secondary && allowed === undefined && limitReached === undefined) {
		throw new Error("Codex usage response contains no usable quota data.");
	}
	return {
		...(primary ? { primary } : {}),
		...(secondary ? { secondary } : {}),
		...(allowed !== undefined ? { allowed } : {}),
		...(limitReached !== undefined ? { limitReached } : {}),
		...(plan ? { plan } : {}),
		observedAtMs: now,
	};
}

async function readJsonBounded(response: Response): Promise<unknown> {
	if (!response.body) return JSON.parse("");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_USAGE_BODY_BYTES) throw new Error("Codex usage response is too large.");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

/** Fetches live quota for one account. Tokens are used only in request headers and never returned. */
export async function fetchAccountUsage(input: {
	credential: Record<string, unknown>;
	accountId: string;
	now?: () => number;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<AccountUsage> {
	const access = typeof input.credential.access === "string" ? input.credential.access : undefined;
	if (!access) throw new Error("Codex account has no access token.");
	const controller = new AbortController();
	const abort = () => controller.abort(input.signal?.reason);
	if (input.signal?.aborted) abort();
	else input.signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("usage_timeout")), input.timeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS);
	try {
		const response = await (input.fetch ?? globalThis.fetch)(CODEX_USAGE_ENDPOINT, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${access}`,
				"ChatGPT-Account-Id": input.accountId,
				Accept: "application/json",
			},
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`Codex usage request failed (${response.status}).`);
		const now = (input.now ?? (() => Date.now()))();
		return normalizeUsageResponse(await readJsonBounded(response), now);
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", abort);
	}
}

function sanitizeWindow(value: unknown): UsageWindow | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const raw = value as Partial<UsageWindow>;
	if (typeof raw.usedPercent !== "number" || !Number.isFinite(raw.usedPercent)) return undefined;
	const seconds = finite(raw.windowSeconds);
	const reset = finite(raw.resetAtMs);
	return {
		usedPercent: Math.max(0, Math.min(100, raw.usedPercent)),
		...(seconds !== undefined ? { windowSeconds: seconds } : {}),
		...(reset !== undefined ? { resetAtMs: reset } : {}),
	};
}

export function storedUsage(record: AccountStateRecord | undefined): AccountUsage | undefined {
	const raw = record?.usage;
	if (typeof raw !== "object" || raw === null) return undefined;
	const observedAtMs = finite(raw.observedAtMs);
	if (observedAtMs === undefined) return undefined;
	const primary = sanitizeWindow(raw.primary);
	const secondary = sanitizeWindow(raw.secondary);
	const allowed = typeof raw.allowed === "boolean" ? raw.allowed : undefined;
	const limitReached = typeof raw.limitReached === "boolean" ? raw.limitReached : undefined;
	const plan = typeof raw.plan === "string" ? raw.plan : undefined;
	if (!primary && !secondary && allowed === undefined && limitReached === undefined) return undefined;
	return {
		...(primary ? { primary } : {}),
		...(secondary ? { secondary } : {}),
		...(allowed !== undefined ? { allowed } : {}),
		...(limitReached !== undefined ? { limitReached } : {}),
		...(plan ? { plan } : {}),
		observedAtMs,
	};
}

export function usageAvailable(usage: AccountUsage): boolean {
	if (usage.allowed === false || usage.limitReached === true) return false;
	if (usage.allowed === true && usage.limitReached === false) return true;
	return ![usage.primary, usage.secondary].some((window) => window && window.usedPercent >= EXHAUSTED_PERCENT);
}

/**
 * Refreshes accounts sequentially. Used by `/codex_pool status`, and only when every local account
 * is unavailable before a model request. A failed account is reported but never blocks the rest.
 */
export async function refreshPoolUsage(input: {
	authPath: string;
	statePath: string;
	accounts: readonly PoolAccount[];
	refresh: (credential: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>;
	now?: () => number;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<UsageRefreshResult[]> {
	const results: UsageRefreshResult[] = [];
	for (const account of [...input.accounts].sort((left, right) => left.ordinal - right.ordinal)) {
		try {
			const observedAtMs = (input.now ?? (() => Date.now()))();
			const fresh = await ensureFreshAccountCredential({
				authPath: input.authPath,
				account,
				refresh: (credential) => input.refresh(credential, input.signal),
				signal: input.signal,
				now: input.now,
			});
			const usage = await fetchAccountUsage({
				credential: fresh.credential,
				accountId: account.id,
				now: input.now,
				fetch: input.fetch,
				signal: input.signal,
				timeoutMs: input.timeoutMs,
			});
			// The request start is the latest instant this response can safely disprove. A quota
			// failure recorded while the response was in flight must survive it.
			usage.observedAtMs = observedAtMs;
			await recordUsage({ statePath: input.statePath, account, usage, clearQuotaCooldowns: usageAvailable(usage) });
			results.push({ account, usage });
		} catch {
			if (input.signal?.aborted) throw input.signal.reason ?? new Error("Request was aborted");
			results.push({ account, error: "usage_unavailable" });
		}
	}
	return results;
}

export interface UsageRefreshResult {
	account: PoolAccount;
	usage?: AccountUsage;
	error?: string;
}

export interface ReadyEstimate {
	accountId: string;
	readyAtMs: number;
}

export function accountReadyAtMs(input: { record: AccountStateRecord | undefined; account: PoolAccount; now: number; modelId?: string }): number | undefined {
	const { record, account, now } = input;
	const future = (candidate: number | null | undefined): number | undefined =>
		typeof candidate === "number" && candidate > now ? candidate : undefined;
	const scopes = new Set(["account", ...(input.modelId ? [`model:${input.modelId}`] : [])]);
	const cooldowns = Object.entries(record?.cooldowns ?? {})
		.filter(([scope, cooldown]) => scopes.has(scope) && cooldown.generation === account.generation)
		.map(([, cooldown]) => cooldown);
	const stated = cooldowns.map((cooldown) => future(cooldown.serverResetAtMs));
	if (cooldowns.length > 0 && stated.some((candidate) => candidate === undefined)) return undefined;
	const usage = storedUsage(record);
	const windows = [usage?.primary, usage?.secondary].filter((window): window is UsageWindow => !!window);
	const exhaustedWindows = windows.filter((window) => window.usedPercent >= EXHAUSTED_PERCENT);
	const explicitlyBlocked = usage?.allowed === false || usage?.limitReached === true;
	const blockingWindows = exhaustedWindows.length > 0 ? exhaustedWindows : explicitlyBlocked ? windows : [];
	const exhausted = blockingWindows.map((window) => future(window.resetAtMs));
	if (explicitlyBlocked && blockingWindows.length === 0) return undefined;
	if (blockingWindows.length > 0 && exhausted.some((candidate) => candidate === undefined)) return undefined;
	// Every active limit must have reset before the account is usable. The later reset wins both
	// across model/account cooldowns and across the primary/secondary quota windows.
	const candidates = [...stated, ...exhausted].filter((candidate): candidate is number => candidate !== undefined);
	return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

export function soonestReady(input: { accounts: readonly PoolAccount[]; state: PoolStateFile; now: number; modelId?: string }): ReadyEstimate | undefined {
	let best: ReadyEstimate | undefined;
	for (const account of input.accounts) {
		const record = input.state.accounts[account.id];
		if (record?.authInvalidGeneration === account.generation) continue;
		const readyAtMs = accountReadyAtMs({ record, account, now: input.now, modelId: input.modelId });
		if (readyAtMs === undefined) continue;
		if (!best || readyAtMs < best.readyAtMs) best = { accountId: account.id, readyAtMs };
	}
	return best;
}

function clockText(atMs: number): string {
	const at = new Date(atMs);
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export function formatRecovery(atMs: number, now: number): string {
	const minutes = Math.max(1, Math.round((atMs - now) / 60_000));
	if (minutes < 60) return `约 ${minutes} 分钟后（${clockText(atMs)}）`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours < 24) return `约 ${hours} 小时${rest > 0 ? ` ${rest} 分钟` : ""}后（${clockText(atMs)}）`;
	return `约 ${Math.floor(hours / 24)} 天 ${hours % 24} 小时后（${clockText(atMs)}）`;
}

function windowName(window: UsageWindow, fallback: string): string {
	if (window.windowSeconds === undefined) return fallback;
	const hours = window.windowSeconds / 3_600;
	if (hours >= 24 && hours % 24 === 0) return `${hours / 24} 天`;
	return Number.isInteger(hours) ? `${hours} 小时` : fallback;
}

export function describeUsage(usage: AccountUsage | undefined, now = Date.now()): string | undefined {
	if (!usage) return undefined;
	const parts: string[] = [];
	const describe = (window: UsageWindow, fallback: string) =>
		`${windowName(window, fallback)}已用 ${Math.round(window.usedPercent)}%${window.resetAtMs ? `，${formatRecovery(window.resetAtMs, now)}重置` : ""}`;
	if (usage.primary) parts.push(describe(usage.primary, "5 小时"));
	if (usage.secondary) parts.push(describe(usage.secondary, "7 天"));
	return parts.length > 0 ? parts.join("；") : undefined;
}

export function describeSoonestReady(input: { accounts: readonly PoolAccount[]; state: PoolStateFile; now: number; modelId?: string }): string | undefined {
	const estimate = soonestReady(input);
	if (!estimate) return undefined;
	const account = input.accounts.find((candidate) => candidate.id === estimate.accountId);
	return `最早可用：${formatRecovery(estimate.readyAtMs, input.now)}，${account ? accountLabel(account) : "某个账号"}`;
}

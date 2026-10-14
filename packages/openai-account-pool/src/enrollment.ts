import {
	accountLabel,
	commitAccount,
	disablePool,
	loadPoolSnapshot,
	maskAccountId,
	removeAccount,
	type PoolAccount,
	type PoolSnapshot,
} from "./auth.ts";
import { availabilityFor, setPreferredAccountId } from "./availability.ts";
import { withEnrollmentLease } from "./lease.ts";
import { emptyPoolState, readPoolState, withPoolStateTransaction, type AuthEntry, type PoolStateFile } from "./store.ts";
import { describeSoonestReady, describeUsage, refreshPoolUsage, storedUsage, usageAvailable } from "./usage.ts";

/**
 * `/codex_pool`: ask, log in once, save, ask again. Everything here is UI-agnostic so the TUI,
 * RPC and tests drive the same loop. Each successful login is saved immediately, so ending the
 * loop, pressing escape or closing pi never loses an account that was already added.
 */

export type EnrollmentChoice = "continue" | "remove" | "end";

export interface EnrollmentView {
	/** Accounts already in the pool before this iteration. */
	savedAccounts: number;
	/** Those accounts by label, so the user can see which ones are already in. */
	savedLabels: string[];
	/** An existing plain login that the first add will keep as a pool account. */
	nativeLoginPending: boolean;
	addedThisRun: number;
	/** Non-secret sentence about what the previous iteration did. */
	lastOutcome?: string;
}

/** The prompt the user reads before every add. Shared by the TUI, RPC and media. */
export function confirmText(view: EnrollmentView): string {
	const lines: string[] = [];
	if (view.lastOutcome) lines.push(view.lastOutcome);
	if (view.savedLabels.length === 0) lines.push("账号池里还没有账号。");
	else lines.push(`已保存 ${view.savedAccounts} 个账号：${view.savedLabels.join("、")}。`);
	if (view.nativeLoginPending) lines.push("原有 openai-codex 登录会在第一次添加时保留并入池。");
	if (view.savedAccounts === 1) lines.push("再添加一个账号才有备用额度。");
	if (view.savedAccounts > 0) lines.push("重复登录已有的账号只会更新它的凭据，不会多出一个。");
	return lines.join("\n");
}

export interface EnrollmentUi {
	/** Shows the state and asks what to do next. */
	confirm(view: EnrollmentView): Promise<EnrollmentChoice>;
	/** Runs exactly one native OAuth login. Rejects when the user cancels. */
	login(): Promise<AuthEntry>;
	/** Picks the account to delete, or undefined when the user backs out. */
	pickRemoval(accounts: readonly PoolAccount[]): Promise<PoolAccount | undefined>;
	notify(message: string, kind?: "info" | "warning" | "error"): void;
}

export interface EnrollmentResult {
	added: number;
	updated: number;
	removed: number;
	/** Accounts in the pool when the loop ended. */
	accounts: number;
	cancelled: boolean;
}

/** Login failures can quote a raw token response, so only a short, scrubbed reason is shown. */
export function redactMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const scrubbed = raw
		.replace(/https?:\/\/\S+/g, "<url>")
		.replace(/[A-Za-z0-9._~+/=-]{24,}/g, "<redacted>")
		.replace(/\s+/g, " ")
		.trim();
	return scrubbed.length > 160 ? `${scrubbed.slice(0, 160)}…` : scrubbed || "未知错误";
}

export function isCancellation(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") return true;
	const message = error instanceof Error ? error.message : String(error);
	return /Login cancelled|cancelled|canceled|aborted/i.test(message);
}

function describeCommit(result: Awaited<ReturnType<typeof commitAccount>>): string {
	const label = accountLabel(result.account);
	const parts = [result.outcome === "added" ? `已添加账号 ${label}` : `${label} 是已在池里的账号，凭据已更新，没有新增`];
	if (result.migratedExistingLogin) parts.push("原有登录已保留并入池");
	if (result.readoptedAccounts > 0) parts.push(`恢复了 ${result.readoptedAccounts} 个此前保存的账号`);
	parts.push(`当前共 ${result.accountCount} 个账号`);
	return `${parts.join("，")}。`;
}

export async function runEnrollment(input: {
	authPath: string;
	statePath: string;
	ui: EnrollmentUi;
	signal?: AbortSignal;
}): Promise<EnrollmentResult> {
	// One wizard at a time per agent directory: two callback servers must never race.
	return withEnrollmentLease({ statePath: input.statePath, purpose: "codex_pool", signal: input.signal }, async () => {
		const result: EnrollmentResult = { added: 0, updated: 0, removed: 0, accounts: 0, cancelled: false };
		let lastOutcome: string | undefined;

		while (true) {
			const snapshot = await loadPoolSnapshot(input.authPath);
			const sorted = [...snapshot.accounts].sort((left, right) => left.ordinal - right.ordinal);
			result.accounts = sorted.length;
			const choice = await input.ui.confirm({
				savedAccounts: sorted.length,
				savedLabels: sorted.map((account) => accountLabel(account)),
				nativeLoginPending: !snapshot.enabled && snapshot.nativeLoginPresent,
				addedThisRun: result.added + result.updated,
				lastOutcome,
			});
			if (choice === "end") break;

			if (choice === "remove") {
				lastOutcome = await removeThroughWizard({ ...input, accounts: sorted, result });
				if (lastOutcome) input.ui.notify(lastOutcome);
				continue;
			}

			let credential: AuthEntry;
			try {
				credential = await input.ui.login();
			} catch (error) {
				if (isCancellation(error)) {
					result.cancelled = true;
					break;
				}
				// A failed login never retries by itself; the next loop asks again.
				lastOutcome = `上一次登录失败（${redactMessage(error)}），已保存的账号不受影响。`;
				continue;
			}

			try {
				const committed = await commitAccount({ authPath: input.authPath, credential, signal: input.signal });
				if (committed.outcome === "added") result.added += 1;
				else result.updated += 1;
				result.accounts = committed.accountCount;
				lastOutcome = describeCommit(committed);
				input.ui.notify(lastOutcome);
			} catch (error) {
				lastOutcome = `上一次保存失败（${redactMessage(error)}），已保存的账号不受影响。`;
			}
		}

		const finalSnapshot = await loadPoolSnapshot(input.authPath);
		result.accounts = finalSnapshot.accounts.length;
		return result;
	});
}

/** Deleting from inside the wizard, so adding and dropping an account need one command. */
async function removeThroughWizard(input: {
	authPath: string;
	statePath: string;
	ui: EnrollmentUi;
	accounts: readonly PoolAccount[];
	result: EnrollmentResult;
}): Promise<string | undefined> {
	if (input.accounts.length === 0) return "账号池里没有可删除的账号。";
	let chosen: PoolAccount | undefined;
	try {
		chosen = await input.ui.pickRemoval(input.accounts);
	} catch (error) {
		if (isCancellation(error)) return undefined;
		throw error;
	}
	if (!chosen) return undefined;
	try {
		const removal = await removePoolAccount({ authPath: input.authPath, statePath: input.statePath, accountId: chosen.id });
		input.result.removed += 1;
		input.result.accounts = removal.remaining;
		return removal.poolDisabled
			? `已删除最后一个账号 ${accountLabel(chosen)}，账号池已关闭。`
			: `已删除账号 ${accountLabel(chosen)}，还剩 ${removal.remaining} 个。`;
	} catch (error) {
		return `删除失败（${redactMessage(error)}），账号池没有变化。`;
	}
}

export type AccountState = "ready" | "cooling" | "reauth" | "probing";

export interface AccountStatusLine {
	label: string;
	state: AccountState;
	detail: string;
	isCurrent: boolean;
	isPreferredForNextSession: boolean;
}

export interface PoolStatus {
	enabled: boolean;
	nativeLoginPresent: boolean;
	accounts: AccountStatusLine[];
	/** Short non-secret summary line for the user. */
	summary: string;
}

/**
 * Sets the account future sessions start from, or returns to automatic order with `undefined`.
 * Failover still applies: a pinned account that runs out of quota hands the request on.
 */
export async function setDefaultAccount(input: { authPath: string; statePath: string; accountId: string | undefined }): Promise<PoolAccount | undefined> {
	if (input.accountId === undefined) {
		await setPreferredAccountId({ statePath: input.statePath, accountId: undefined });
		return undefined;
	}
	const snapshot = await loadPoolSnapshot(input.authPath);
	const account = snapshot.accounts.find((candidate) => candidate.id === input.accountId);
	if (!account) throw new AccountQueryError("这个账号不在账号池里，无法设为默认。");
	await setPreferredAccountId({ statePath: input.statePath, accountId: account.id });
	return account;
}

export async function poolStatus(input: {
	authPath: string;
	statePath: string;
	/** Account that has completed a request in this Pi session. */
	currentAccountId?: string;
	now?: number;
	modelId?: string;
	refresh?: (credential: AuthEntry, signal?: AbortSignal) => Promise<AuthEntry>;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}): Promise<PoolStatus> {
	const now = input.now ?? Date.now();
	const snapshot = await loadPoolSnapshot(input.authPath);
	if (!snapshot.enabled) {
		return {
			enabled: false,
			nativeLoginPresent: snapshot.nativeLoginPresent,
			accounts: [],
			summary: snapshot.nativeLoginPresent
				? "账号池未启用，当前使用原生单账号登录。运行 /codex_pool 添加账号即可启用。"
				: "账号池未启用，且没有 openai-codex 登录。运行 /codex_pool 添加账号。",
		};
	}

	const refreshed = input.refresh
		? await refreshPoolUsage({
				authPath: input.authPath,
				statePath: input.statePath,
				accounts: snapshot.accounts,
				refresh: input.refresh,
				now: () => now,
				fetch: input.fetch,
				signal: input.signal,
			})
		: [];
	const refreshById = new Map(refreshed.map((result) => [result.account.id, result]));
	const state = await readPoolState(input.statePath);
	const availability = availabilityFor({
		accounts: snapshot.accounts,
		state,
		now,
		modelId: input.modelId,
	});
	const accounts = availability.map((entry, index): AccountStatusLine => {
		const account = snapshot.accounts[index];
		const label = accountLabel(account);
		const isCurrent = account.id === input.currentAccountId;
		const isPreferredForNextSession = account.id === state.preferredAccountId;
		const live = refreshById.get(account.id);
		const usage = live?.usage ?? storedUsage(state.accounts[account.id]);
		const usageText = live?.error ? "用量未知" : describeUsage(usage, now) ?? "用量未知";
		if (entry.authInvalid) return { label, state: "reauth", detail: "需要重新授权，运行 /codex_pool 重新登录这个账号", isCurrent, isPreferredForNextSession };
		if (entry.unavailable?.reason === "probe_in_progress") return { label, state: "probing", detail: "另一个进程正在重试", isCurrent, isPreferredForNextSession };
		if (entry.unavailable || (usage && !usageAvailable(usage))) {
			const reset = entry.unavailable?.serverResetAtMs;
			return {
				label,
				state: "cooling",
				detail: `${usageText}；${reset ? `额度冷却中，约 ${Math.max(1, Math.round((reset - now) / 60_000))} 分钟后恢复` : "额度暂不可用"}`,
				isCurrent,
				isPreferredForNextSession,
			};
		}
		return { label, state: "ready", detail: `${usageText}；${entry.needsProbe ? "冷却已过，下次请求会先试这个账号" : "可用"}`, isCurrent, isPreferredForNextSession };
	});

	const ready = accounts.filter((entry) => entry.state === "ready").length;
	let summary =
		accounts.length === 1
			? "账号池已启用，但只有 1 个账号，暂无备用账号。运行 /codex_pool 继续添加。"
			: `账号池已启用：${accounts.length} 个账号，其中 ${ready} 个现在可用。`;
	if (ready === 0) {
		const recovery = describeSoonestReady({ accounts: snapshot.accounts, state, now, modelId: input.modelId });
		if (recovery) summary += ` ${recovery}。`;
	}
	return { enabled: true, nativeLoginPresent: false, accounts, summary };
}

export class AccountQueryError extends Error {}

/** Accepts the ordinal, the sign-in address, a full account id or the masked suffix from status. */
export function resolveAccount(snapshot: PoolSnapshot, query: string): PoolAccount {
	const trimmed = query.trim().replace(/^[#…\s]+/, "");
	if (!trimmed) throw new AccountQueryError("请提供要删除的账号编号、邮箱或标识，例如 /codex_pool remove 2。");
	const byOrdinal = /^\d+$/.test(trimmed) ? snapshot.accounts.find((account) => account.ordinal === Number(trimmed)) : undefined;
	if (byOrdinal) return byOrdinal;
	const needle = trimmed.toLowerCase();
	const byEmail = snapshot.accounts.filter((account) => account.email?.toLowerCase().includes(needle));
	if (byEmail.length === 1) return byEmail[0];
	if (byEmail.length > 1) throw new AccountQueryError(`“${trimmed}”匹配到 ${byEmail.length} 个账号，请用编号，例如 /codex_pool remove 2。`);
	const matches = snapshot.accounts.filter((account) => account.id === trimmed || account.id.endsWith(trimmed));
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) throw new AccountQueryError(`“${trimmed}”匹配到 ${matches.length} 个账号，请用编号，例如 /codex_pool remove 2。`);
	throw new AccountQueryError(`没有找到账号“${trimmed}”。用 /codex_pool status 查看编号。`);
}

/** Forgets everything the pool recorded about accounts it no longer owns. */
async function forgetState(statePath: string, accountIds: readonly string[] | "all"): Promise<void> {
	await withPoolStateTransaction(statePath, (state) => {
		if (accountIds === "all") return { value: { ...emptyPoolState(), enrollment: state.enrollment }, result: undefined };
		const accounts = { ...state.accounts };
		for (const accountId of accountIds) delete accounts[accountId];
		const next: PoolStateFile = { ...state, accounts };
		// References to an account that no longer exists would silently lie; drop them instead.
		if (next.preferredAccountId && accountIds.includes(next.preferredAccountId)) delete next.preferredAccountId;
		if (next.currentAccountId && accountIds.includes(next.currentAccountId)) delete next.currentAccountId;
		return { value: next, result: undefined };
	});
}

export async function endPool(input: { authPath: string; statePath: string; keepAccountId?: string }): Promise<{ kept: PoolAccount; dormantAccounts: number }> {
	const snapshot = await loadPoolSnapshot(input.authPath);
	if (!snapshot.enabled) throw new AccountQueryError("账号池未启用，无需关闭。");
	const keep =
		snapshot.accounts.find((account) => account.id === input.keepAccountId) ??
		[...snapshot.accounts].sort((left, right) => left.ordinal - right.ordinal)[0];
	const result = await disablePool({ authPath: input.authPath, accountId: keep.id });
	await forgetState(input.statePath, "all");
	return { kept: result.restored, dormantAccounts: result.dormantAccounts };
}

export async function removePoolAccount(input: { authPath: string; statePath: string; accountId: string }): Promise<{ removed: PoolAccount; remaining: number; poolDisabled: boolean }> {
	const result = await removeAccount({ authPath: input.authPath, accountId: input.accountId });
	await forgetState(input.statePath, result.poolDisabled ? "all" : [input.accountId]);
	return result;
}

export { maskAccountId };

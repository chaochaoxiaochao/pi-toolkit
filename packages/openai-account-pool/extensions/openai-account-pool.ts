import type { AuthEvent, AuthPrompt, OAuthCredential, Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	LoginDialogComponent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { accountLabel, loadPoolSnapshot, maskAccountId, type PoolAccount } from "../src/auth.ts";
import { readPreferredAccountId } from "../src/availability.ts";
import { codexPoolArgumentCompletions } from "../src/command-completions.ts";
import {
	AccountQueryError,
	confirmText,
	endPool,
	isCancellation,
	poolStatus,
	redactMessage,
	removePoolAccount,
	resolveAccount,
	runEnrollment,
	setDefaultAccount,
	type EnrollmentUi,
	type PoolStatus,
} from "../src/enrollment.ts";
import { EnrollmentInProgressError } from "../src/lease.ts";
import { LoginSlot, type LoginDialog, type LoginSlotUi } from "../src/login-slot.ts";
import { createPoolProvider } from "../src/provider.ts";
import { CodexPoolStatusWidget, formatAccountStatusLine } from "../src/status-widget.ts";
import { authPathFor, poolStatePathFor, type AuthEntry } from "../src/store.ts";

const PROVIDER_ID = "openai-codex";
const PROVIDER_NAME = "OpenAI (ChatGPT Plus/Pro)";
/** Marks our wrapper so a reload cannot wrap the wrapper again. */
const POOL_WRAPPER = Symbol.for("pi-openai-account-pool.wrapper");

const CONTINUE = "继续：登录并添加一个账号";
const REMOVE = "删除：从账号池里移除一个账号";
const END = "结束：保留账号池和自动切换";
const BACK = "返回：什么都不做";
const AUTOMATIC = "自动：按编号顺序，用着哪个顺手就留在哪个";
const DIALOG_TITLE = "添加 Codex 账号";
const STATUS_WIDGET_KEY = "openai-account-pool-status";
const STATUS_VISIBLE_MS = 15_000;

function agentPaths() {
	const agentDir = getAgentDir();
	return { authPath: authPathFor(agentDir), statePath: poolStatePathFor(agentDir) };
}

/**
 * Drives the native OAuth flow through pi's own login dialog, exactly like `/login` does.
 *
 * The dialog and pi's selectors share one slot below the chat, so `LoginSlot` owns that slot and
 * decides what is mounted when.
 */
async function loginWithDialog(ctx: ExtensionContext, oauth: NonNullable<Provider["auth"]["oauth"]>): Promise<OAuthCredential> {
	const ui: LoginSlotUi = {
		mount: (register) =>
			ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
				const dialog = new LoginDialogComponent(tui, PROVIDER_ID, () => done(undefined), PROVIDER_NAME, DIALOG_TITLE);
				register(dialog satisfies LoginDialog, () => done(undefined));
				return dialog;
			}),
		select: (message, options, signal) => ctx.ui.select(message, [...options], { signal }),
	};
	const slot = new LoginSlot(ui);
	try {
		return await oauth.login(slot.interaction);
	} finally {
		await slot.close();
	}
}

async function selectThroughDialog(ctx: ExtensionContext, request: AuthPrompt & { type: "select" }): Promise<string> {
	const labels = request.options.map((option) => option.label);
	const chosen = await ctx.ui.select(request.message, labels);
	const index = chosen === undefined ? -1 : labels.indexOf(chosen);
	if (index < 0) throw new Error("Login cancelled");
	return request.options[index].id;
}

/** Dialog-capable modes without a terminal, such as RPC, use the standard dialogs. */
async function loginWithDialogs(ctx: ExtensionContext, oauth: NonNullable<Provider["auth"]["oauth"]>): Promise<OAuthCredential> {
	const controller = new AbortController();
	const prompt = async (request: AuthPrompt): Promise<string> => {
		if (request.type === "select") return selectThroughDialog(ctx, request);
		const answer = await ctx.ui.input(request.message, request.placeholder, { signal: request.signal });
		if (answer === undefined) throw new Error("Login cancelled");
		return answer;
	};
	const notify = (event: AuthEvent) => {
		if (event.type === "auth_url") ctx.ui.notify(`在浏览器中打开以授权：${event.url}`);
		else if (event.type === "device_code") ctx.ui.notify(`在 ${event.verificationUri} 输入代码 ${event.userCode}`);
		else ctx.ui.notify(event.message);
	};
	return oauth.login({ signal: controller.signal, prompt, notify } satisfies ProviderAuthInteraction);
}

/** Lets the user point at one account with the arrow keys instead of typing an identifier. */
async function pickAccount(ctx: ExtensionContext, message: string, accounts: readonly PoolAccount[], extra: string[] = []): Promise<PoolAccount | string | undefined> {
	const labels = accounts.map((account) => accountLabel(account));
	const chosen = await ctx.ui.select(message, [...labels, ...extra, BACK]);
	if (chosen === undefined || chosen === BACK) return undefined;
	const index = labels.indexOf(chosen);
	return index >= 0 ? accounts[index] : chosen;
}

function enrollmentUi(ctx: ExtensionContext, oauth: NonNullable<Provider["auth"]["oauth"]>): EnrollmentUi {
	return {
		confirm: async (view) => {
			const options = view.savedAccounts > 0 ? [CONTINUE, REMOVE, END] : [CONTINUE, END];
			const choice = await ctx.ui.select(confirmText(view), options);
			if (choice === CONTINUE) return "continue";
			return choice === REMOVE ? "remove" : "end";
		},
		login: async () => {
			const credential = ctx.mode === "tui" ? await loginWithDialog(ctx, oauth) : await loginWithDialogs(ctx, oauth);
			return credential as unknown as AuthEntry;
		},
		pickRemoval: async (accounts) => {
			const chosen = await pickAccount(ctx, "删除哪个账号？会删掉本地凭据，不会撤销 OpenAI 上的授权。", accounts);
			return typeof chosen === "object" ? chosen : undefined;
		},
		notify: (message, kind) => ctx.ui.notify(message, kind ?? "info"),
	};
}

async function readStatus(ctx: ExtensionContext, live: boolean, signal?: AbortSignal): Promise<PoolStatus> {
	const { authPath, statePath } = agentPaths();
	const oauth = ctx.modelRegistry.getProvider(PROVIDER_ID)?.auth.oauth;
	return poolStatus({
		authPath,
		statePath,
		modelId: ctx.model?.id,
		refresh: live && oauth
			? async (credential, signal) =>
					oauth.refresh(credential as unknown as OAuthCredential, signal ?? new AbortController().signal) as unknown as AuthEntry
			: undefined,
		signal,
	});
}

async function showStatus(ctx: ExtensionContext, showTuiStatus: (ctx: ExtensionContext) => void): Promise<void> {
	if (ctx.mode === "tui") {
		showTuiStatus(ctx);
		return;
	}
	const status = await readStatus(ctx, true);
	const lines = [status.summary, ...status.accounts.map(formatAccountStatusLine)];
	ctx.ui.notify(lines.join("\n"));
}

async function handleCommand(
	args: string,
	ctx: ExtensionCommandContext,
	provider: () => Provider | undefined,
	showTuiStatus: (ctx: ExtensionContext) => void,
): Promise<void> {
	const [subcommand = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
	const { authPath, statePath } = agentPaths();

	try {
		if (subcommand === "status") {
			await showStatus(ctx, showTuiStatus);
			return;
		}

		if (subcommand === "off") {
			const snapshot = await loadPoolSnapshot(authPath);
			if (!snapshot.enabled) {
				ctx.ui.notify("账号池未启用，无需关闭。", "warning");
				return;
			}
			const keep = [...snapshot.accounts].sort((left, right) => left.ordinal - right.ordinal)[0];
			const confirmed = await ctx.ui.confirm(
				"关闭 Codex 账号池？",
				`将恢复为单账号登录（保留 ${maskAccountId(keep.id)}），其余 ${snapshot.accounts.length - 1} 个账号的本地凭据会保留但不再使用。`,
			);
			if (!confirmed) return;
			const result = await endPool({ authPath, statePath, keepAccountId: keep.id });
			ctx.ui.notify(`已关闭账号池，恢复为单账号登录（${maskAccountId(result.kept.id)}）。`);
			return;
		}

		if (subcommand === "use") {
			const snapshot = await loadPoolSnapshot(authPath);
			if (!snapshot.enabled) throw new AccountQueryError("账号池未启用，没有可切换的账号。");
			const query = rest.join(" ");
			if (query === "auto") {
				await setDefaultAccount({ authPath, statePath, accountId: undefined });
				ctx.ui.notify("已恢复自动选号。");
				return;
			}
			const accounts = [...snapshot.accounts].sort((left, right) => left.ordinal - right.ordinal);
			const current = await readPreferredAccountId(statePath);
			const chosen = query
				? resolveAccount(snapshot, query)
				: await pickAccount(ctx, `默认用哪个账号？当前：${current ? accountLabel(accounts.find((account) => account.id === current) ?? accounts[0]) : "自动"}`, accounts, [AUTOMATIC]);
			if (chosen === undefined) return;
			if (chosen === AUTOMATIC) {
				await setDefaultAccount({ authPath, statePath, accountId: undefined });
				ctx.ui.notify("已恢复自动选号。");
				return;
			}
			const account = chosen as PoolAccount;
			await setDefaultAccount({ authPath, statePath, accountId: account.id });
			ctx.ui.notify(`以后从 ${accountLabel(account)} 开始。它额度用完或需要重新授权时，仍会自动切到其他账号。`);
			return;
		}

		if (subcommand === "remove") {
			const snapshot = await loadPoolSnapshot(authPath);
			if (!snapshot.enabled) throw new AccountQueryError("账号池未启用，没有可删除的池内账号。");
			const query = rest.join(" ");
			const accounts = [...snapshot.accounts].sort((left, right) => left.ordinal - right.ordinal);
			const chosen = query
				? resolveAccount(snapshot, query)
				: await pickAccount(ctx, "删除哪个账号？", accounts);
			if (chosen === undefined) return;
			const account = chosen as PoolAccount;
			const confirmed = await ctx.ui.confirm("删除这个 Codex 账号？", `将删除 ${accountLabel(account)} 的本地凭据，不会撤销 OpenAI 上的授权。`);
			if (!confirmed) return;
			const result = await removePoolAccount({ authPath, statePath, accountId: account.id });
			ctx.ui.notify(
				result.poolDisabled
					? `已删除最后一个账号 ${accountLabel(account)}，账号池已关闭，openai-codex 现在没有登录。`
					: `已删除账号 ${accountLabel(account)}，还剩 ${result.remaining} 个。`,
			);
			return;
		}

		if (subcommand) {
			ctx.ui.notify("用法：/codex_pool [status|use [编号|邮箱|auto]|remove [编号|邮箱]|off]", "warning");
			return;
		}

		if (!ctx.hasUI) {
			ctx.ui.notify("当前模式没有交互界面，无法添加账号。请在交互式 pi 中运行 /codex_pool；已有账号池的模型请求不受影响。", "error");
			return;
		}

		const oauth = provider()?.auth.oauth;
		if (!oauth) {
			ctx.ui.notify("找不到 openai-codex 的 OAuth 登录方式。", "error");
			return;
		}

		const result = await runEnrollment({ authPath, statePath, ui: enrollmentUi(ctx, oauth) });
		if (result.cancelled) ctx.ui.notify(`已取消这次授权。当前共 ${result.accounts} 个账号。`, "warning");
		else if (result.added + result.updated + result.removed === 0) ctx.ui.notify(`没有改动。当前共 ${result.accounts} 个账号。`);
		else ctx.ui.notify(`账号池共 ${result.accounts} 个账号${result.accounts > 1 ? "，额度耗尽时会自动切换" : "，暂无备用账号"}。`);
	} catch (error) {
		if (error instanceof EnrollmentInProgressError) {
			ctx.ui.notify("另一个 pi 正在添加 Codex 账号，请等它结束后再试。", "warning");
			return;
		}
		if (error instanceof AccountQueryError) {
			ctx.ui.notify(error.message, "warning");
			return;
		}
		if (isCancellation(error)) {
			ctx.ui.notify("已取消。", "warning");
			return;
		}
		ctx.ui.notify(`/codex_pool 失败：${redactMessage(error)}`, "error");
	}
}

export default function openaiAccountPool(pi: ExtensionAPI) {
	let base: Provider | undefined;
	let latest: ExtensionContext | undefined;
	let statusPanel: { component: CodexPoolStatusWidget; tui: { requestRender(): void } } | undefined;
	let statusController: AbortController | undefined;
	let statusTimer: ReturnType<typeof setTimeout> | undefined;
	let statusGeneration = 0;

	const clearStatusPanel = (ctx: ExtensionContext) => {
		statusController?.abort();
		statusController = undefined;
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = undefined;
		ctx.ui.setWidget(STATUS_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		statusPanel = undefined;
	};

	const showTuiStatus = (ctx: ExtensionContext) => {
		clearStatusPanel(ctx);
		const generation = ++statusGeneration;
		const controller = new AbortController();
		statusController = controller;
		let status: PoolStatus | undefined;
		let loading = true;
		let updateFailed = false;
		const render = () => {
			if (generation !== statusGeneration) return;
			statusPanel?.component.update(status, { loading, updateFailed });
			statusPanel?.tui.requestRender();
		};
		ctx.ui.setWidget(STATUS_WIDGET_KEY, (tui, theme) => {
			const component = new CodexPoolStatusWidget(theme);
			statusPanel = { component, tui };
			render();
			return component;
		}, { placement: "aboveEditor" });
		void (async () => {
			try {
				status = await readStatus(ctx, false, controller.signal);
				if (generation !== statusGeneration) return;
				render();
				status = await readStatus(ctx, true, controller.signal);
				if (generation !== statusGeneration) return;
				loading = false;
				render();
			} catch {
				if (controller.signal.aborted || generation !== statusGeneration) return;
				loading = false;
				updateFailed = true;
				render();
			} finally {
				if (!controller.signal.aborted && generation === statusGeneration) {
					statusTimer = setTimeout(() => clearStatusPanel(ctx), STATUS_VISIBLE_MS);
				}
			}
		})();
	};

	const install = (ctx: ExtensionContext) => {
		latest = ctx;
		const current = ctx.modelRegistry.getProvider(PROVIDER_ID);
		if (!current || (current as Record<symbol, unknown>)[POOL_WRAPPER]) {
			base ??= current;
			return;
		}
		base = current;
		const { authPath, statePath } = agentPaths();
		const wrapped = createPoolProvider(current, {
			lazyStream,
			authPath,
			statePath,
			// Switch notes go to whichever context is current when the request runs.
			notify: (message) => latest?.ui.notify(message, "warning"),
		});
		Object.defineProperty(wrapped, POOL_WRAPPER, { value: true, enumerable: false });
		ctx.modelRegistry.registerProvider(wrapped);
	};

	pi.on("session_start", (_event, ctx) => {
		install(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		statusGeneration += 1;
		if (ctx.mode === "tui") clearStatusPanel(ctx);
		latest = undefined;
	});

	pi.registerCommand("codex_pool", {
		description: "添加并管理多个 ChatGPT 账号，额度耗尽时自动切换",
		getArgumentCompletions: codexPoolArgumentCompletions,
		handler: async (args, ctx) => {
			install(ctx);
			await handleCommand(args, ctx, () => base, showTuiStatus);
		},
	});
}

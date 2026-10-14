import assert from "node:assert/strict";

import { commitAccount, loadPoolSnapshot } from "../src/auth.ts";
import { availabilityFor, claimProbeLease, recordFailure, recordSuccess, setPreferredAccountId } from "../src/availability.ts";
import { poolStatus } from "../src/enrollment.ts";
import { CodexPoolStatusWidget, formatAccountStatusLine } from "../src/status-widget.ts";
import { poolStatePathFor, readPoolState } from "../src/store.ts";
import {
	CODEX_USAGE_ENDPOINT,
	accountReadyAtMs,
	fetchAccountUsage,
	normalizeUsageResponse,
	refreshPoolUsage,
	soonestReady,
} from "../src/usage.ts";
import { fakeAccessToken, fakeCredential, makeAgentDir } from "./helpers/fixtures.mjs";

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const ACCOUNT_A = "account-aaaa";
const ACCOUNT_B = "account-bbbb";

function usagePayload({ primary = 20, secondary = 30, primaryReset = NOW + 60_000, secondaryReset = NOW + 120_000, allowed = true } = {}) {
	return {
		plan_type: "plus",
		rate_limit: {
			allowed,
			limit_reached: !allowed,
			primary_window: { used_percent: primary, limit_window_seconds: 18_000, reset_at: Math.floor(primaryReset / 1_000) },
			secondary_window: { used_percent: secondary, limit_window_seconds: 604_800, reset_at: Math.floor(secondaryReset / 1_000) },
		},
	};
}

function response(payload, status = 200) {
	return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function setupPool(credentials = [
	fakeCredential(ACCOUNT_A, { now: NOW, email: "a@example.com", plan: "plus" }),
	fakeCredential(ACCOUNT_B, { now: NOW, email: "b@example.com", plan: "plus" }),
]) {
	const agent = makeAgentDir();
	for (const credential of credentials) await commitAccount({ authPath: agent.authPath, credential, now: NOW });
	return { agent, statePath: poolStatePathFor(agent.directory), snapshot: await loadPoolSnapshot(agent.authPath) };
}

// Normalization recognizes the real 5-hour and weekly windows, clamps percentages, and converts epoch seconds.
{
	const usage = normalizeUsageResponse(usagePayload({ primary: -4, secondary: 140 }), NOW);
	assert.deepEqual(
		{ primary: usage.primary, secondary: usage.secondary },
		{
			primary: { usedPercent: 0, windowSeconds: 18_000, resetAtMs: NOW + 60_000 },
			secondary: { usedPercent: 100, windowSeconds: 604_800, resetAtMs: NOW + 120_000 },
		},
	);
	assert.equal(usage.plan, "plus");
	assert.equal(usage.observedAtMs, NOW);
}

// The private endpoint receives exactly the bearer token and account selector it requires.
{
	const token = fakeAccessToken(ACCOUNT_A);
	let call;
	const usage = await fetchAccountUsage({
		credential: { access: token },
		accountId: ACCOUNT_A,
		now: () => NOW,
		fetch: async (input, init) => {
			call = { input: String(input), init };
			return response(usagePayload());
		},
	});
	assert.equal(call.input, CODEX_USAGE_ENDPOINT);
	assert.equal(call.init.method, "GET");
	assert.equal(call.init.headers.Authorization, `Bearer ${token}`);
	assert.equal(call.init.headers["ChatGPT-Account-Id"], ACCOUNT_A);
	assert.equal(usage.primary.windowSeconds, 18_000);
}

// Bad status, malformed JSON/data and oversized bodies fail without putting credentials in errors.
{
	const secret = "never-print-this-token";
	for (const fetch of [
		async () => response({ error: "nope" }, 503),
		async () => response("not-json"),
		async () => response({ unrelated: true }),
		async () => response("x".repeat(256 * 1024 + 1)),
	]) {
		await assert.rejects(
			fetchAccountUsage({ credential: { access: secret }, accountId: ACCOUNT_A, fetch, now: () => NOW }),
			(error) => error instanceof Error && !error.message.includes(secret),
		);
	}
}

// The body limit is enforced while streaming and the remaining body is cancelled.
{
	let pulls = 0;
	let cancelled = false;
	const encoder = new TextEncoder();
	const chunks = [
		encoder.encode(`${JSON.stringify(usagePayload())}${" ".repeat(200_000)}`),
		encoder.encode(" ".repeat(100_000)),
		...Array.from({ length: 8 }, () => encoder.encode("should-not-be-read")),
	];
	const body = new ReadableStream({
		pull(controller) {
			controller.enqueue(chunks[pulls++]);
			if (pulls === chunks.length) controller.close();
		},
		cancel() { cancelled = true; },
	});
	await assert.rejects(
		fetchAccountUsage({ credential: { access: "fixture-token" }, accountId: ACCOUNT_A, fetch: async () => new Response(body), now: () => NOW }),
		/too large/,
	);
	assert.equal(cancelled, true);
	assert.ok(pulls < chunks.length);
}

// A private-endpoint stall is locally bounded even without a caller cancellation signal.
{
	await assert.rejects(
		fetchAccountUsage({
			credential: { access: "fixture-token" },
			accountId: ACCOUNT_A,
			timeoutMs: 5,
			fetch: async (_input, init) => new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
			}),
		}),
		(error) => error instanceof Error && error.name === "AbortError",
	);
}

// Every account is queried sequentially; a failure does not prevent later accounts from updating.
{
	const { agent, statePath, snapshot } = await setupPool();
	try {
		const order = [];
		let releaseFirst;
		const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
		let firstStarted;
		const started = new Promise((resolve) => { firstStarted = resolve; });
		const pending = refreshPoolUsage({
			authPath: agent.authPath,
			statePath,
			accounts: snapshot.accounts,
			refresh: async (credential) => credential,
			now: () => NOW,
			fetch: async (_input, init) => {
				const id = init.headers["ChatGPT-Account-Id"];
				order.push(id);
				if (id === ACCOUNT_A) {
					firstStarted();
					await firstHeld;
				}
				return id === ACCOUNT_A ? response({}, 500) : response(usagePayload());
			},
		});
		await started;
		assert.deepEqual(order, [ACCOUNT_A]);
		releaseFirst();
		const results = await pending;
		assert.deepEqual(order, [ACCOUNT_A, ACCOUNT_B]);
		assert.ok(results[0].error);
		assert.equal(results[1].usage.primary.usedPercent, 20);
		assert.equal((await readPoolState(statePath)).accounts[ACCOUNT_B].usage.observedAtMs, NOW);
	} finally {
		agent.dispose();
	}
}

// Credential freshness uses the injected clock; a valid credential is never refreshed.
{
	const { agent, statePath, snapshot } = await setupPool([fakeCredential(ACCOUNT_A, { now: NOW, expiresInMs: 60 * 60_000 })]);
	try {
		let refreshes = 0;
		await refreshPoolUsage({
			authPath: agent.authPath,
			statePath,
			accounts: snapshot.accounts,
			refresh: async (credential) => { refreshes += 1; return credential; },
			now: () => NOW,
			fetch: async () => response(usagePayload()),
		});
		assert.equal(refreshes, 0);
	} finally {
		agent.dispose();
	}
}

// Expired OAuth credentials are refreshed first and the rotated access token is used for usage lookup.
{
	const old = fakeCredential(ACCOUNT_A, { now: NOW, expiresInMs: 0 });
	const { agent, statePath, snapshot } = await setupPool([old]);
	try {
		const rotated = fakeCredential(ACCOUNT_A, { now: NOW, marker: "rotated" });
		let refreshes = 0;
		let authorization;
		await refreshPoolUsage({
			authPath: agent.authPath,
			statePath,
			accounts: snapshot.accounts,
			refresh: async () => { refreshes += 1; return rotated; },
			now: () => NOW,
			fetch: async (_input, init) => { authorization = init.headers.Authorization; return response(usagePayload()); },
		});
		assert.equal(refreshes, 1);
		assert.equal(authorization, `Bearer ${rotated.access}`);
	} finally {
		agent.dispose();
	}
}

// Refresh and parser failures collapse to a fixed non-secret result code.
{
	const { agent, statePath, snapshot } = await setupPool([fakeCredential(ACCOUNT_A, { now: NOW, expiresInMs: 0 })]);
	try {
		const results = await refreshPoolUsage({
			authPath: agent.authPath,
			statePath,
			accounts: snapshot.accounts,
			refresh: async () => { throw new Error("refresh-token-secret-value-123456789"); },
			now: () => NOW,
			fetch: async () => response(usagePayload()),
		});
		assert.equal(results[0].error, "usage_unavailable");
		assert.doesNotMatch(JSON.stringify(results), /refresh-token-secret/);
	} finally {
		agent.dispose();
	}
}

// An older available observation cannot erase newer usage or quota-failure evidence.
{
	const { agent, statePath, snapshot } = await setupPool([fakeCredential(ACCOUNT_A, { now: NOW })]);
	try {
		const account = snapshot.accounts[0];
		await refreshPoolUsage({
			authPath: agent.authPath,
			statePath,
			accounts: [account],
			refresh: async (credential) => credential,
			now: () => NOW + 1_000,
			fetch: async () => response(usagePayload({ primary: 100, allowed: false, primaryReset: NOW + 300_000 })),
		});
		await recordFailure({ statePath, account, now: NOW + 1_000, classification: { kind: "quota", reason: "usage_limit_reached", scope: "account", serverResetAtMs: NOW + 300_000 } });
		await refreshPoolUsage({
			authPath: agent.authPath,
			statePath,
			accounts: [account],
			refresh: async (credential) => credential,
			now: () => NOW,
			fetch: async () => response(usagePayload({ allowed: true })),
		});
		const state = await readPoolState(statePath);
		assert.equal(state.accounts[ACCOUNT_A].usage.allowed, false);
		assert.ok(state.accounts[ACCOUNT_A].cooldowns.account);
	} finally {
		agent.dispose();
	}
}

// Clearing recovered quota evidence does not bypass another process's active probe lease.
{
	const { agent, statePath, snapshot } = await setupPool([fakeCredential(ACCOUNT_A, { now: NOW })]);
	try {
		const account = snapshot.accounts[0];
		await recordFailure({ statePath, account, now: NOW - 120_000, classification: { kind: "quota", reason: "usage_limit_reached", scope: "account", serverResetAtMs: NOW - 60_000 } });
		assert.equal(await claimProbeLease({ statePath, accountId: account.id, owner: "other", now: NOW }), true);
		await refreshPoolUsage({
			authPath: agent.authPath,
			statePath,
			accounts: [account],
			refresh: async (credential) => credential,
			now: () => NOW,
			fetch: async () => response(usagePayload({ allowed: true })),
		});
		const state = await readPoolState(statePath);
		const [availability] = availabilityFor({ accounts: [account], state, now: NOW, probeOwner: "this-process" });
		assert.equal(availability.unavailable.reason, "probe_in_progress");
	} finally {
		agent.dispose();
	}
}

// Live availability clears quota evidence only; auth-invalid evidence survives. Exhaustion retains cooldowns.
{
	const { agent, statePath, snapshot } = await setupPool();
	try {
		const [accountA, accountB] = snapshot.accounts;
		await recordFailure({ statePath, account: accountA, now: NOW, classification: { kind: "quota", reason: "usage_limit_reached", scope: "account", serverResetAtMs: NOW + 60_000 } });
		await recordFailure({ statePath, account: accountA, now: NOW, classification: { kind: "auth_invalid", reason: "authorization_failed" } });
		await recordFailure({ statePath, account: accountB, now: NOW, classification: { kind: "quota", reason: "usage_limit_reached", scope: "account", serverResetAtMs: NOW + 120_000 } });
		await refreshPoolUsage({
			authPath: agent.authPath,
			statePath,
			accounts: snapshot.accounts,
			refresh: async (credential) => credential,
			now: () => NOW,
			fetch: async (_input, init) => init.headers["ChatGPT-Account-Id"] === ACCOUNT_A
				? response(usagePayload({ allowed: true }))
				: response(usagePayload({ primary: 100, allowed: false })),
		});
		const state = await readPoolState(statePath);
		assert.deepEqual(state.accounts[ACCOUNT_A].cooldowns, {});
		assert.equal(state.accounts[ACCOUNT_A].authInvalidGeneration, accountA.generation);
		assert.ok(state.accounts[ACCOUNT_B].cooldowns.account);
	} finally {
		agent.dispose();
	}
}

// Readiness waits for every blocking window and chooses the earliest account, not the earliest limit.
{
	const accounts = [
		{ id: ACCOUNT_A, key: "a", ordinal: 1, addedAt: NOW, generation: 1 },
		{ id: ACCOUNT_B, key: "b", ordinal: 2, addedAt: NOW, generation: 1 },
	];
	const state = {
		v: 1,
		accounts: {
			[ACCOUNT_A]: {
				cooldowns: { account: { reason: "usage_limit_reached", generation: 1, serverResetAtMs: NOW + 60_000, probeAfterMs: null, recordedAtMs: NOW } },
				usage: { primary: { usedPercent: 100, resetAtMs: NOW + 300_000 }, secondary: { usedPercent: 100, resetAtMs: NOW + 180_000 }, observedAtMs: NOW },
			},
			[ACCOUNT_B]: {
				cooldowns: { account: { reason: "usage_limit_reached", generation: 1, serverResetAtMs: NOW + 240_000, probeAfterMs: null, recordedAtMs: NOW } },
			},
		},
	};
	assert.equal(accountReadyAtMs({ account: accounts[0], record: state.accounts[ACCOUNT_A], now: NOW }), NOW + 300_000);
	assert.deepEqual(soonestReady({ accounts, state, now: NOW }), { accountId: ACCOUNT_B, readyAtMs: NOW + 240_000 });
}

// Recovery ignores unrelated model cooldowns and refuses partial estimates with unknown blockers.
{
	const account = { id: ACCOUNT_A, key: "a", ordinal: 1, addedAt: NOW, generation: 1 };
	const record = {
		cooldowns: {
			account: { reason: "usage_limit_reached", generation: 1, serverResetAtMs: NOW + 60_000, probeAfterMs: null, recordedAtMs: NOW },
			"model:other": { reason: "usage_limit_reached", generation: 1, serverResetAtMs: NOW + 7 * 86_400_000, probeAfterMs: null, recordedAtMs: NOW },
		},
	};
	assert.equal(accountReadyAtMs({ account, record, now: NOW, modelId: "wanted" }), NOW + 60_000);
	record.usage = {
		allowed: false,
		limitReached: true,
		primary: { usedPercent: 100 },
		secondary: { usedPercent: 100, resetAtMs: NOW + 600_000 },
		observedAtMs: NOW,
	};
	assert.equal(accountReadyAtMs({ account, record, now: NOW, modelId: "wanted" }), undefined);
}

// Status queries all accounts, shows email and usage, and uses only this session's current account.
{
	const { agent, statePath, snapshot } = await setupPool();
	try {
		await recordSuccess({ statePath, account: snapshot.accounts[1], requestStartedAtMs: NOW });
		await setPreferredAccountId({ statePath, accountId: ACCOUNT_A });
		const queried = [];
		const status = await poolStatus({
			authPath: agent.authPath,
			statePath,
			currentAccountId: ACCOUNT_B,
			now: NOW,
			refresh: async (credential) => credential,
			fetch: async (_input, init) => { queried.push(init.headers["ChatGPT-Account-Id"]); return response(usagePayload()); },
		});
		assert.deepEqual(queried, [ACCOUNT_A, ACCOUNT_B]);
		assert.equal(status.accounts.length, 2);
		assert.match(status.accounts[0].label, /a@example\.com/);
		assert.doesNotMatch(status.accounts[0].label, /当前|默认/);
		assert.match(status.accounts[1].label, /b@example\.com/);
		assert.equal(status.accounts[0].isCurrent, false);
		assert.equal(status.accounts[0].isPreferred, true);
		assert.equal(status.accounts[1].isCurrent, true);
		assert.equal(status.accounts[1].isPreferred, false);
		assert.match(formatAccountStatusLine(status.accounts[0]), /★首选$/);
		assert.match(formatAccountStatusLine(status.accounts[1]), /●本会话$/);
		assert.doesNotMatch(status.accounts[1].label, /★默认/);
		const theme = { fg: (_color, text) => text };
		const widget = new CodexPoolStatusWidget(theme);
		assert.match(widget.render(96).join("\n"), /正在读取账号池状态/);
		widget.update(status, { loading: true });
		const rendered = widget.render(160);
		assert.match(rendered.join("\n"), /正在更新官网额度/);
		const currentLine = rendered.find((line) => line.includes("●本会话"));
		const preferredLine = rendered.find((line) => line.includes("★首选"));
		assert.ok(currentLine, JSON.stringify(rendered));
		assert.ok(preferredLine, JSON.stringify(rendered));
		assert.match(currentLine, /●本会话$/);
		const unusedSession = await poolStatus({ authPath: agent.authPath, statePath, now: NOW });
		assert.equal(unusedSession.accounts.some((account) => account.isCurrent), false);
		assert.doesNotMatch(unusedSession.accounts.map(formatAccountStatusLine).join("\n"), /●本会话/);
		for (const line of status.accounts) {
			assert.match(line.detail, /5 小时已用 20%/);
			assert.match(line.detail, /7 天已用 30%/);
			assert.match(line.detail, /重置/);
		}
	} finally {
		agent.dispose();
	}
}

// Preference and session use are independent facts, so both markers remain visible.
{
	const account = {
		label: "#2 (b@example.com)",
		state: "ready",
		detail: "可用",
		isCurrent: true,
		isPreferred: true,
	};
	assert.match(formatAccountStatusLine(account), /★首选 ●本会话$/);
	const widget = new CodexPoolStatusWidget({ fg: (_color, text) => text });
	widget.update({ enabled: true, nativeLoginPresent: false, accounts: [account], summary: "" }, { loading: false });
	const rendered = widget.render(120).join("\n");
	assert.match(rendered, /★首选 ●本会话/);
}

// A failed live status lookup retains stored exhaustion and does not count the account as ready.
{
	const { agent, statePath } = await setupPool([fakeCredential(ACCOUNT_A, { now: NOW })]);
	try {
		await poolStatus({
			authPath: agent.authPath,
			statePath,
			now: NOW,
			refresh: async (credential) => credential,
			fetch: async () => response(usagePayload({ primary: 100, allowed: false, primaryReset: NOW + 600_000 })),
		});
		const status = await poolStatus({
			authPath: agent.authPath,
			statePath,
			now: NOW,
			refresh: async (credential) => credential,
			fetch: async () => response({}, 503),
		});
		assert.equal(status.accounts[0].state, "cooling");
		assert.match(status.accounts[0].detail, /用量未知/);
		assert.doesNotMatch(status.summary, /1 个现在可用/);
	} finally {
		agent.dispose();
	}
}

console.log("Usage endpoint tests passed");

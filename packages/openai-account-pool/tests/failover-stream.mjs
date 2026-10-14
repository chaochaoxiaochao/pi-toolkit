import assert from "node:assert/strict";

import { accountIdOf, commitAccount, loadPoolSnapshot, POOL_UNRESOLVED_API_KEY } from "../src/auth.ts";
import { recordFailure, setPreferredAccountId } from "../src/availability.ts";
import { createPoolProvider } from "../src/provider.ts";
import { poolStatePathFor, readPoolState } from "../src/store.ts";
import { fakeAccessToken, fakeCredential, makeAgentDir } from "./helpers/fixtures.mjs";
import { piAiEntry } from "./helpers/pi-runtime.mjs";

const { createAssistantMessageEventStream, lazyStream } = await import(piAiEntry());

const MODEL = {
	id: "gpt-5-codex",
	name: "GPT-5 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const CONTEXT = { messages: [] };
const ACCOUNT_A = "account-aaaa";
const ACCOUNT_B = "account-bbbb";

function assistantMessage(text, { error } = {}) {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: error ? "error" : "stop",
		...(error ? { errorMessage: error } : {}),
		timestamp: new Date().toISOString(),
	};
}

/**
 * Stands in for the built-in Codex adapter: it performs one HTTP call through the injected
 * fetch, then reports success or a provider-shaped error event, exactly like the real one.
 */
function scriptedProvider(steps, log) {
	const run = async (options, stream) => {
		const step = steps.shift() ?? { kind: "ok", text: "unscripted" };
		log.attempts.push({ apiKey: options?.apiKey, step: step.kind });
		const response = await options.fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST" });
		if (!response.ok) {
			// The real adapter turns any usage-limit-ish failure into the same friendly sentence.
			const friendly = response.status === 429 ? "You have hit your ChatGPT usage limit." : `Request failed (${response.status})`;
			stream.push({ type: "error", reason: "error", error: assistantMessage(undefined, { error: friendly }) });
			return;
		}
		await options.onProviderStreamEvent?.({ type: "response.created" }, MODEL);
		const partial = assistantMessage(step.text ?? "");
		stream.push({ type: "start", partial });
		if (step.kind !== "ok-empty") {
			stream.push({ type: "text_start", contentIndex: 0, partial });
			stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial });
			stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial });
		}
		stream.push({ type: "done", reason: "stop", message: partial });
	};

	const start = (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		run(options, stream).catch((error) => {
			stream.push({ type: "error", reason: "error", error: assistantMessage(undefined, { error: String(error) }) });
		});
		return stream;
	};

	return {
		id: "openai-codex",
		name: "OpenAI Codex",
		baseUrl: "https://chatgpt.com/backend-api",
		auth: {
			oauth: {
				name: "OpenAI (ChatGPT Plus/Pro)",
				isSubscription: true,
				login: async () => {
					throw new Error("not used in this test");
				},
				refresh: async (credential) => {
					const accountId = accountIdOf(credential);
					log.refreshes.push(accountId);
					return { type: "oauth", access: fakeAccessToken(accountId, "rotated"), refresh: `${credential.refresh}-next`, expires: Date.now() + 3_600_000, accountId };
				},
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		getModels: () => [MODEL],
		stream: start,
		streamSimple: start,
	};
}

function jsonResponse(status, payload) {
	return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** Caller-supplied fetch: proves the pool passes the caller's own instrumentation through. */
function scriptedFetch(responses, log) {
	return async (input, init) => {
		log.fetches.push(String(input));
		const next = responses.shift();
		return next ? next() : new Response("{}", { status: 200 });
	};
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

async function setupPool(accounts = [ACCOUNT_A, ACCOUNT_B]) {
	const agent = makeAgentDir();
	for (const accountId of accounts) {
		await commitAccount({ authPath: agent.authPath, credential: fakeCredential(accountId) });
	}
	return { agent, statePath: poolStatePathFor(agent.directory) };
}

function exhaustedUsageResponse() {
	return jsonResponse(200, {
		rate_limit: {
			allowed: false,
			limit_reached: true,
			primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1_000) + 1_800 },
		},
	});
}

function poolRuntime(agent, statePath, notes, usageFetch = async () => exhaustedUsageResponse(), preferredAccountId) {
	return { lazyStream, authPath: agent.authPath, statePath, probeOwner: "test-owner", notify: (message) => notes.push(message), usageFetch, preferredAccountId };
}

// ---------------------------------------------------------------------------
// A proven subscription limit switches accounts, invisibly to the caller.
// ---------------------------------------------------------------------------
{
	const { agent, statePath } = await setupPool();
	try {
		const log = { attempts: [], refreshes: [], fetches: [] };
		const notes = [];
		const base = scriptedProvider([{ kind: "quota" }, { kind: "ok", text: "hello" }], log);
		const provider = createPoolProvider(base, poolRuntime(agent, statePath, notes));
		const observed = [];

		const events = await collect(
			provider.stream(MODEL, CONTEXT, {
				apiKey: POOL_UNRESOLVED_API_KEY,
				fetch: scriptedFetch([() => jsonResponse(429, { error: { code: "usage_limit_reached", plan_type: "plus", resets_at: Math.floor(Date.now() / 1_000) + 1_800 } })], log),
				onProviderStreamEvent: (data) => observed.push(data),
			}),
		);

		assert.equal(events.filter((event) => event.type === "start").length, 1, "the caller sees exactly one response start");
		assert.equal(events.filter((event) => event.type === "error").length, 0, "the failed attempt is never shown");
		assert.equal(events.at(-1).type, "done");
		assert.equal(events.at(-1).message.content[0].text, "hello");
		assert.equal(log.attempts.length, 2, "both accounts were tried once");
		assert.equal(log.fetches.length, 2, "the caller's own fetch stayed in the request path");
		assert.deepEqual(observed, [{ type: "response.created" }], "the caller's stream observer still fires");

		const usedTokens = log.attempts.map((attempt) => attempt.apiKey);
		assert.ok(!usedTokens.includes(POOL_UNRESOLVED_API_KEY), "the placeholder never reaches the provider");
		assert.notEqual(usedTokens[0], usedTokens[1], "the retry used a different account");
		assert.equal(notes.length, 1);
		assert.match(notes[0], /额度已用尽/);
		assert.ok(!notes[0].includes(ACCOUNT_A), "account ids are masked in user-visible notes");

		const state = await readPoolState(statePath);
		assert.equal(state.accounts[ACCOUNT_A].cooldowns.account.reason, "usage_limit_reached");
		assert.equal(state.accounts[ACCOUNT_B], undefined, "a working account records nothing");

		// Sticky: the next request starts on the account that just worked.
		const second = { attempts: log.attempts, refreshes: log.refreshes, fetches: log.fetches };
		base.__steps = undefined;
		const followUp = createPoolProvider(scriptedProvider([{ kind: "ok", text: "again" }], second), poolRuntime(agent, statePath, notes));
		await collect(followUp.stream(MODEL, CONTEXT, { apiKey: POOL_UNRESOLVED_API_KEY, fetch: scriptedFetch([], second) }));
		assert.equal(second.attempts.at(-1).apiKey, usedTokens[1], "the limited account is skipped while it is cooling down");
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// Plain rate limiting looks identical to the user but must not burn the pool.
// ---------------------------------------------------------------------------
{
	const { agent, statePath } = await setupPool();
	try {
		const log = { attempts: [], refreshes: [], fetches: [] };
		const notes = [];
		const base = scriptedProvider([{ kind: "rate-limit" }, { kind: "ok", text: "never reached" }], log);
		const provider = createPoolProvider(base, poolRuntime(agent, statePath, notes));

		const events = await collect(
			provider.stream(MODEL, CONTEXT, {
				apiKey: POOL_UNRESOLVED_API_KEY,
				fetch: scriptedFetch([() => jsonResponse(429, { error: { message: "You have hit your ChatGPT usage limit." } })], log),
			}),
		);

		assert.equal(log.attempts.length, 1, "a misleading usage-limit message is not evidence of a subscription limit");
		assert.equal(events.at(-1).type, "error");
		assert.match(events.at(-1).error.errorMessage, /usage limit/);
		assert.deepEqual((await readPoolState(statePath)).accounts, {}, "no cooldown is recorded for ordinary rate limiting");
		assert.deepEqual(notes, []);
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// A limit that arrives after output ends this request but still informs the next one.
// ---------------------------------------------------------------------------
{
	const { agent, statePath } = await setupPool();
	try {
		const log = { attempts: [], refreshes: [], fetches: [] };
		const base = scriptedProvider([], log);
		// Emit real output first, then fail with a proven limit.
		base.stream = (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			(async () => {
				log.attempts.push({ apiKey: options.apiKey, step: "partial" });
				const partial = assistantMessage("half");
				stream.push({ type: "start", partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "half", partial });
				await options.fetch("https://chatgpt.com/backend-api/codex/responses", {});
				stream.push({ type: "error", reason: "error", error: assistantMessage(undefined, { error: "You have hit your ChatGPT usage limit." }) });
			})();
			return stream;
		};
		const provider = createPoolProvider(base, poolRuntime(agent, statePath, []));

		const events = await collect(
			provider.stream(MODEL, CONTEXT, {
				apiKey: POOL_UNRESOLVED_API_KEY,
				fetch: scriptedFetch([() => jsonResponse(429, { error: { code: "usage_limit_reached", plan_type: "plus" } })], log),
			}),
		);

		assert.equal(log.attempts.length, 1, "delivered output can never be replayed on another account");
		assert.deepEqual(events.map((event) => event.type), ["start", "text_delta", "error"]);
		const state = await readPoolState(statePath);
		assert.equal(state.accounts[ACCOUNT_A].cooldowns.account.reason, "usage_limit_reached", "the next request will skip this account");
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// A rejected token is repaired once on the same account before any switch.
// ---------------------------------------------------------------------------
{
	const { agent, statePath } = await setupPool();
	try {
		const log = { attempts: [], refreshes: [], fetches: [] };
		const base = scriptedProvider([{ kind: "unauthorized" }, { kind: "ok", text: "recovered" }], log);
		const provider = createPoolProvider(base, poolRuntime(agent, statePath, []));

		const events = await collect(
			provider.stream(MODEL, CONTEXT, {
				apiKey: POOL_UNRESOLVED_API_KEY,
				fetch: scriptedFetch([() => jsonResponse(401, { error: { message: "Unauthorized" } })], log),
			}),
		);

		assert.deepEqual(log.refreshes, [ACCOUNT_A], "the rejected credential is rotated exactly once");
		assert.equal(log.attempts.length, 2);
		assert.equal(log.attempts[0].apiKey === log.attempts[1].apiKey, false, "the retry uses the rotated token");
		assert.equal(events.at(-1).message.content[0].text, "recovered");
		assert.deepEqual((await readPoolState(statePath)).accounts[ACCOUNT_A]?.cooldowns ?? {}, {}, "a repaired account is not marked unavailable");
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// With every account limited the request stops immediately with a masked status.
// ---------------------------------------------------------------------------
{
	const { agent, statePath } = await setupPool();
	try {
		const log = { attempts: [], refreshes: [], fetches: [] };
		const notes = [];
		const base = scriptedProvider([{ kind: "quota" }, { kind: "quota" }, { kind: "ok", text: "must not happen" }], log);
		const provider = createPoolProvider(base, poolRuntime(agent, statePath, notes));
		const limit = () => jsonResponse(429, { error: { code: "usage_limit_reached", plan_type: "plus" } });

		const events = await collect(
			provider.stream(MODEL, CONTEXT, { apiKey: POOL_UNRESOLVED_API_KEY, fetch: scriptedFetch([limit, limit], log) }),
		);

		assert.equal(log.attempts.length, 2, "each account is tried at most once per request");
		assert.equal(events.at(-1).type, "error");
		assert.equal(events.at(-1).error.errorMessage, "You have hit your ChatGPT usage limit.", "the provider's own error is forwarded untouched");
		assert.match(notes.at(-1), /账号池暂时都不可用/, "the user is told the whole pool is out");

		// A later request does not even start: it reports the masked status immediately.
		const next = await collect(provider.stream(MODEL, CONTEXT, { apiKey: POOL_UNRESOLVED_API_KEY, fetch: scriptedFetch([], log) }));
		assert.equal(log.attempts.length, 2, "no request is sent while every account is cooling down");
		const failure = next.at(-1);
		assert.equal(failure.type, "error");
		assert.match(failure.error.errorMessage, /账号池暂时都不可用/);
		assert.match(failure.error.errorMessage, /codex_pool/);
		for (const secret of [ACCOUNT_A, ACCOUNT_B, fakeAccessToken(ACCOUNT_A), POOL_UNRESOLVED_API_KEY]) {
			assert.ok(!failure.error.errorMessage.includes(secret), "the exhausted-pool message stays non-secret");
			assert.ok(!notes.at(-1).includes(secret), "the exhausted-pool note stays non-secret");
		}
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// When all local cooldowns block a request, usage is checked once and a recovered account runs.
// ---------------------------------------------------------------------------
{
	const { agent, statePath } = await setupPool();
	try {
		const snapshot = await loadPoolSnapshot(agent.authPath);
		const now = Date.now();
		for (const account of snapshot.accounts) {
			await recordFailure({
				statePath,
				account,
				now,
				classification: { kind: "quota", reason: "usage_limit_reached", scope: "account", serverResetAtMs: now + 30 * 60_000 },
			});
		}
		const usageQueries = [];
		const usageFetch = async (_input, init) => {
			const id = init.headers["ChatGPT-Account-Id"];
			usageQueries.push(id);
			return jsonResponse(200, {
				rate_limit: {
					allowed: id === ACCOUNT_A,
					limit_reached: id !== ACCOUNT_A,
					primary_window: {
						used_percent: id === ACCOUNT_A ? 10 : 100,
						limit_window_seconds: 18_000,
						reset_at: Math.floor((now + 30 * 60_000) / 1_000),
					},
				},
			});
		};
		const log = { attempts: [], refreshes: [], fetches: [] };
		const provider = createPoolProvider(
			scriptedProvider([{ kind: "ok", text: "recovered by usage" }], log),
			poolRuntime(agent, statePath, [], usageFetch),
		);
		const events = await collect(provider.stream(MODEL, CONTEXT, {
			apiKey: POOL_UNRESOLVED_API_KEY,
			fetch: scriptedFetch([], log),
		}));
		assert.deepEqual(usageQueries, [ACCOUNT_A, ACCOUNT_B], "every account is checked sequentially exactly once");
		assert.equal(log.attempts.length, 1);
		assert.equal(log.attempts[0].apiKey, fakeAccessToken(ACCOUNT_A), "the recovered account handles the model request");
		assert.equal(events.at(-1).message.content[0].text, "recovered by usage");
	} finally {
		agent.dispose();
	}
}

// If the one usage pass finds no recovery, it stops and reports the earliest server ready time.
{
	const { agent, statePath } = await setupPool();
	try {
		const snapshot = await loadPoolSnapshot(agent.authPath);
		const now = Date.now();
		const resets = new Map([[ACCOUNT_A, now + 20 * 60_000], [ACCOUNT_B, now + 10 * 60_000]]);
		for (const account of snapshot.accounts) {
			await recordFailure({
				statePath,
				account,
				now,
				classification: { kind: "quota", reason: "usage_limit_reached", scope: "account", serverResetAtMs: resets.get(account.id) },
			});
		}
		let usageQueries = 0;
		const usageFetch = async (_input, init) => {
			usageQueries += 1;
			const reset = resets.get(init.headers["ChatGPT-Account-Id"]);
			return jsonResponse(200, {
				rate_limit: {
					allowed: false,
					limit_reached: true,
					primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_at: Math.floor(reset / 1_000) },
				},
			});
		};
		const log = { attempts: [], refreshes: [], fetches: [] };
		const provider = createPoolProvider(scriptedProvider([], log), poolRuntime(agent, statePath, [], usageFetch));
		const events = await collect(provider.stream(MODEL, CONTEXT, { apiKey: POOL_UNRESOLVED_API_KEY, fetch: scriptedFetch([], log) }));
		assert.equal(usageQueries, 2, "automatic usage probing does not loop within one logical request");
		assert.equal(log.attempts.length, 0);
		assert.match(events.at(-1).error.errorMessage, /最早可用：约 10 分钟后/);
		assert.match(events.at(-1).error.errorMessage, /#2/);
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// Requests that are not pool-resolved keep the caller's own credential.
// ---------------------------------------------------------------------------
{
	const { agent, statePath } = await setupPool();
	try {
		const log = { attempts: [], refreshes: [], fetches: [] };
		const provider = createPoolProvider(scriptedProvider([{ kind: "ok", text: "direct" }], log), poolRuntime(agent, statePath, []));

		await collect(provider.stream(MODEL, CONTEXT, { apiKey: "caller-owned-key", fetch: scriptedFetch([], log) }));
		assert.equal(log.attempts[0].apiKey, "caller-owned-key", "an explicit credential is never replaced by a pool token");

		// A custom endpoint must not receive pool tokens either.
		const custom = { ...MODEL, baseUrl: "https://example.invalid/v1" };
		await collect(provider.stream(custom, CONTEXT, { apiKey: POOL_UNRESOLVED_API_KEY, fetch: scriptedFetch([], log) }));
		assert.equal(log.attempts[1].apiKey, POOL_UNRESOLVED_API_KEY, "the unresolved placeholder fails visibly instead of leaking a token");
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// The stored pool reference resolves to a placeholder, never to a usable token.
// ---------------------------------------------------------------------------
{
	const { agent, statePath } = await setupPool();
	try {
		const log = { attempts: [], refreshes: [], fetches: [] };
		const provider = createPoolProvider(scriptedProvider([], log), poolRuntime(agent, statePath, []));
		const entries = JSON.parse(await (await import("node:fs/promises")).readFile(agent.authPath, "utf8"));

		assert.deepEqual(await provider.auth.oauth.toAuth(entries["openai-codex"]), { apiKey: POOL_UNRESOLVED_API_KEY });
		assert.deepEqual(await provider.auth.oauth.refresh(entries["openai-codex"]), entries["openai-codex"], "the reference is never exchanged for a token");
		assert.deepEqual(log.refreshes, []);

		const plain = fakeCredential("account-cccc");
		assert.deepEqual(await provider.auth.oauth.toAuth(plain), { apiKey: plain.access }, "a plain login still resolves normally");
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// Transports without an HTTP error, such as WebSocket, report the limit as a stream event.
// ---------------------------------------------------------------------------
{
	const { agent, statePath } = await setupPool();
	try {
		const log = { attempts: [], refreshes: [], fetches: [] };
		const base = scriptedProvider([], log);
		const steps = [
			{ failed: { error: { code: "usage_limit_reached", plan_type: "pro" } } },
			{ failed: { error: { code: "server_error" } } },
		];
		base.stream = (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			(async () => {
				log.attempts.push({ apiKey: options.apiKey, step: "websocket" });
				const step = steps.shift();
				if (!step) {
					const partial = assistantMessage("ws ok");
					stream.push({ type: "start", partial });
					stream.push({ type: "done", reason: "stop", message: partial });
					return;
				}
				await options.onProviderStreamEvent({ type: "response.failed", response: step.failed }, model);
				stream.push({ type: "error", reason: "error", error: assistantMessage(undefined, { error: "stream failed" }) });
			})();
			return stream;
		};
		const provider = createPoolProvider(base, poolRuntime(agent, statePath, []));

		await collect(provider.stream(MODEL, CONTEXT, { apiKey: POOL_UNRESOLVED_API_KEY, transport: "websocket" }));
		assert.equal(log.attempts.length, 2, "a limit seen only in the event stream still switches accounts");
		assert.equal((await readPoolState(statePath)).accounts[ACCOUNT_A].cooldowns.account.reason, "usage_limit_reached");

		// The second account's unstructured failure is not evidence of anything, so it stops there.
		assert.equal((await readPoolState(statePath)).accounts[ACCOUNT_B], undefined);
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// A cancelled request stays cancelled: no retry on another account, no cooldown.
// ---------------------------------------------------------------------------
{
	const { agent, statePath } = await setupPool();
	try {
		const log = { attempts: [], refreshes: [], fetches: [] };
		const controller = new AbortController();
		const base = scriptedProvider([], log);
		base.stream = (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			log.attempts.push({ apiKey: options.apiKey, step: "cancelled" });
			controller.abort();
			stream.push({ type: "error", reason: "aborted", error: assistantMessage(undefined, { error: "Request was aborted" }) });
			return stream;
		};
		const provider = createPoolProvider(base, poolRuntime(agent, statePath, []));

		const events = await collect(provider.stream(MODEL, CONTEXT, { apiKey: POOL_UNRESOLVED_API_KEY, signal: controller.signal }));
		assert.equal(log.attempts.length, 1);
		assert.equal(events.at(-1).error.stopReason, "error");
		assert.equal(events.at(-1).reason, "aborted");
		assert.deepEqual((await readPoolState(statePath)).accounts, {}, "cancelling proves nothing about the account");
	} finally {
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// A hand-picked default is sampled for a new session, then stays stable for that session.
// ---------------------------------------------------------------------------
{
	const { agent, statePath } = await setupPool();
	try {
		await setPreferredAccountId({ statePath, accountId: ACCOUNT_B });
		const log = { attempts: [], refreshes: [], fetches: [] };
		const notes = [];
		const provider = createPoolProvider(
			scriptedProvider([{ kind: "ok", text: "from b" }], log),
			poolRuntime(agent, statePath, notes, undefined, ACCOUNT_B),
		);
		await setPreferredAccountId({ statePath, accountId: ACCOUNT_A });
		await collect(provider.stream(MODEL, CONTEXT, { apiKey: POOL_UNRESOLVED_API_KEY, fetch: scriptedFetch([], log) }));
		assert.equal(accountIdOf({ access: log.attempts[0].apiKey }), ACCOUNT_B, "changing the global default does not change an existing session");

		const nextSessionLog = { attempts: [], refreshes: [], fetches: [] };
		const nextSession = createPoolProvider(
			scriptedProvider([{ kind: "ok", text: "from a" }], nextSessionLog),
			poolRuntime(agent, statePath, notes, undefined, ACCOUNT_A),
		);
		await collect(nextSession.stream(MODEL, CONTEXT, { apiKey: POOL_UNRESOLVED_API_KEY, fetch: scriptedFetch([], nextSessionLog) }));
		assert.equal(accountIdOf({ access: nextSessionLog.attempts[0].apiKey }), ACCOUNT_A, "a new session uses the new global default");

		// Pinning is a starting point, not a cage: a used-up default still hands the request on.
		await setPreferredAccountId({ statePath, accountId: ACCOUNT_B });
		const failover = { attempts: [], refreshes: [], fetches: [] };
		const second = createPoolProvider(
			scriptedProvider([{ kind: "quota" }, { kind: "ok", text: "from a" }], failover),
			poolRuntime(agent, statePath, notes, undefined, ACCOUNT_B),
		);
		const events = await collect(
			second.stream(MODEL, CONTEXT, {
				apiKey: POOL_UNRESOLVED_API_KEY,
				fetch: scriptedFetch([() => jsonResponse(429, { error: { code: "usage_limit_reached", plan_type: "plus", resets_at: Math.floor(Date.now() / 1_000) + 1_800 } })], failover),
			}),
		);
		assert.equal(events.at(-1).message.content[0].text, "from a");
		assert.deepEqual(
			failover.attempts.map((attempt) => accountIdOf({ access: attempt.apiKey })),
			[ACCOUNT_B, ACCOUNT_A],
			"the pinned account is tried first, then the pool takes over",
		);
		assert.equal((await readPoolState(statePath)).preferredAccountId, ACCOUNT_B, "a failover does not silently repoint the default");
	} finally {
		agent.dispose();
	}
}

console.log("Stream failover tests passed");

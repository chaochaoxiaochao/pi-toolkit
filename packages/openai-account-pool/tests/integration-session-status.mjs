import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { commitAccount, POOL_UNRESOLVED_API_KEY } from "../src/auth.ts";
import { setPreferredAccountId } from "../src/availability.ts";
import { poolStatePathFor } from "../src/store.ts";
import { fakeCredential, makeAgentDir } from "./helpers/fixtures.mjs";
import { piCodingAgentEntry } from "./helpers/pi-runtime.mjs";

const agent = makeAgentDir("pool-session-status-");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousFetch = globalThis.fetch;
process.env.PI_CODING_AGENT_DIR = agent.directory;

const entry = pathToFileURL(piCodingAgentEntry());
const { ExtensionRunner, SessionManager } = await import(entry.href);
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", entry).href);
const ACCOUNT_A = "account-aaaa";
const ACCOUNT_B = "account-bbbb";
const model = {
	id: "gpt-5-codex", name: "GPT-5 Codex", api: "openai-codex-responses", provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api/codex", input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const message = {
	role: "assistant", content: [{ type: "text", text: "ok" }],
	api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const attempts = [];
async function* stream(_model, _context, options) {
	attempts.push(options.apiKey);
	const response = await options.fetch("https://chatgpt.com/backend-api/codex/responses");
	if (!response.ok) {
		yield { type: "error", reason: "error", error: { ...message, content: [], stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit." } };
		return;
	}
	yield { type: "start", partial: message };
	yield { type: "done", reason: "stop", message };
}
const native = {
	id: "openai-codex", name: "fixture", baseUrl: model.baseUrl, stream, streamSimple: stream,
	auth: { oauth: {
		name: "fixture", isSubscription: true,
		login: async () => { throw new Error("No real login allowed"); },
		refresh: async (credential) => credential,
		toAuth: async (credential) => ({ apiKey: credential.access }),
	} },
};
let provider = native;
const registrations = [];
const registry = {
	getProvider: () => provider,
	registerProvider: (wrapped) => { provider = wrapped; registrations.push(wrapped); },
};
const notes = [];
let widget;
let renders = 0;
const ui = {
	notify: (text) => notes.push(text),
	setWidget: (_key, factory) => {
		widget = factory?.({ requestRender: () => { renders += 1; } }, { fg: (_color, text) => text });
	},
};
const runners = [];

async function status(runner, mode = "tui") {
	runner.setUIContext(ui, mode);
	const context = runner.createCommandContext();
	await runner.getCommand("codex_pool").handler("status", context);
	if (mode !== "tui") return notes.at(-1).split("\n");
	for (let attempt = 0; attempt < 200; attempt++) {
		const lines = widget.render(200);
		if (!lines.some((line) => /正在读取|正在更新/.test(line))) return lines;
		await delay(5);
	}
	throw new Error("Status widget did not finish updating");
}

async function request(fetch) {
	const events = [];
	for await (const event of provider.stream(model, { messages: [] }, { apiKey: POOL_UNRESOLVED_API_KEY, fetch })) events.push(event);
	assert.equal(events.at(-1).type, "done");
}

try {
	const credentialA = fakeCredential(ACCOUNT_A);
	await commitAccount({ authPath: agent.authPath, credential: credentialA });
	await commitAccount({ authPath: agent.authPath, credential: fakeCredential(ACCOUNT_B) });
	await setPreferredAccountId({ statePath: poolStatePathFor(agent.directory), accountId: ACCOUNT_B });
	globalThis.fetch = async (url, options) => {
		assert.equal(String(url), "https://chatgpt.com/backend-api/wham/usage", "Only fixture quota lookups are allowed");
		const exhausted = options.headers["ChatGPT-Account-Id"] === ACCOUNT_B;
		return Response.json({ rate_limit: {
			allowed: !exhausted, limit_reached: exhausted,
			primary_window: { used_percent: exhausted ? 100 : 0, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1_000) + 1_800 },
		} });
	};
	const loaded = await loadExtensions([fileURLToPath(new URL("../extensions/openai-account-pool.ts", import.meta.url))], agent.directory);
	assert.deepEqual(loaded.errors, []);
	const session = SessionManager.inMemory(agent.directory);
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, agent.directory, session, registry);
	runners.push(runner);
	runner.setUIContext(ui, "tui");
	const errors = [];
	runner.onError((error) => errors.push(error));
	await runner.emit({ type: "session_start" });
	assert.deepEqual(errors, []);

	// The preferred account exhausts quota; the same logical request succeeds on A.
	let first = true;
	await request(async () => {
		if (!first) return Response.json({});
		first = false;
		return Response.json({ error: { code: "usage_limit_reached", resets_at: Math.floor(Date.now() / 1_000) + 1_800 } }, { status: 429 });
	});
	assert.equal(attempts.length, 2);
	assert.equal(attempts.at(-1), credentialA.access);
	assert.ok(notes.some((note) => note.includes("切换到")));

	// Pi creates a new command context, even though the session has not changed.
	const lines = await status(runner);
	assert.match(lines.find((line) => line.includes("#1")), /●本会话$/,
		"the account that succeeded after failover must remain current in a fresh command context");
	assert.match(lines.find((line) => line.includes("#2")), /★首选$/);
	assert.equal(lines.filter((line) => line.includes("●本会话")).length, 1);
	assert.ok(renders > 0);
	assert.equal(registrations.length, 1, "status must not reinstall or reset the session provider");

	const rpcLines = await status(runner, "rpc");
	assert.match(rpcLines.find((line) => line.includes("#1")), /●本会话$/);
	assert.equal(registrations.length, 1);

	await runner.getCommand("codex_pool").handler("use auto", runner.createCommandContext());
	assert.equal(registrations.length, 1, "preference commands must not reset the session provider");
	await request(async () => Response.json({}));
	assert.equal(attempts.at(-1), credentialA.access, "the existing session keeps its account");

	// A separate session must not inherit another session's successful-account marker.
	const otherSession = SessionManager.inMemory(agent.directory);
	assert.notEqual(otherSession.getSessionId(), session.getSessionId());
	const other = new ExtensionRunner(loaded.extensions, loaded.runtime, agent.directory, otherSession, registry);
	runners.push(other);
	other.setUIContext(ui, "tui");
	await other.emit({ type: "session_start" });
	assert.equal(registrations.length, 2);
	assert.doesNotMatch((await status(other)).join("\n"), /●本会话/);
	await request(async () => Response.json({}));
	assert.match((await status(other)).find((line) => line.includes("#1")), /★首选 ●本会话$/);

	// Shutdown receives yet another context; it must clear both installation and UI state.
	await other.emit({ type: "session_shutdown" });
	await other.emit({ type: "session_start" });
	assert.equal(registrations.length, 3);
	assert.doesNotMatch((await status(other)).join("\n"), /●本会话/);
	assert.deepEqual(errors, []);
	console.log("Session status extension integration checks passed");
} finally {
	for (const runner of runners) await runner.emit({ type: "session_shutdown" });
	globalThis.fetch = previousFetch;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	agent.dispose();
}

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createGuestServer } from "../guest/service.mjs";
import { MAX_LINE_BYTES } from "../guest/protocol.mjs";

const piBinary = process.env.PI_TEST_BINARY || execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
const piPath = realpathSync(piBinary);
const install = resolve(dirname(piPath), "../install");
const current = join(install, "current-version");
const modules = process.env.PI_TEST_MODULES || (existsSync(current)
	? join(install, "releases", readFileSync(current, "utf8").trim(), "node_modules")
	: resolve(dirname(piPath), "../../../.."));
const hostManifest = join(modules, "@earendil-works/pi-coding-agent/package.json");
registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(specifier, ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"].includes(specifier)
			? { ...context, parentURL: pathToFileURL(hostManifest).href } : context);
	},
});

const { default: register } = await import("../extensions/claude-cage.ts");
const { loadProfile, saveCatalog } = await import("../src/profile.ts");
const { parseModels } = await import("../src/provider.ts");
const { requestCage } = await import("../src/transport.ts");
const { normalizeContext, isRetryableAssistantError, isContextOverflow, retryAssistantCall } = await import("@earendil-works/pi-ai");
const extension = fileURLToPath(new URL("../extensions/claude-cage.ts", import.meta.url));
const model = {
	id: "claude-mock", provider: "upstream", api: "upstream-api", baseUrl: "process://upstream",
	name: "Mock Claude", input: ["text", "image"], reasoning: true,
	contextWindow: 200_000, maxTokens: 16_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
	input: 15, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 24,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const user = (content) => ({ role: "user", content, timestamp: 5 });

function mount(dir, { confirm = async () => false, hasUI = true } = {}) {
	const commands = new Map();
	const events = new Map();
	const notifications = [];
	let provider;
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		register({
			registerProvider(registered) { provider = registered; },
			registerCommand(name, command) { commands.set(name, command); },
			on(name, handler) { events.set(name, handler); },
		});
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
	const ctx = {
		hasUI, isIdle: () => true,
		ui: { confirm, notify: (message, type) => notifications.push({ message, type }) },
		modelRegistry: { async refresh(options) {
			assert.deepEqual(options.providers, ["claude-cage"]);
			assert.equal(options.allowNetwork, false);
			return { errors: new Map() };
		} },
	};
	return {
		provider, notifications,
		command: (name, args = "") => commands.get(`claude-cage-${name}`).handler(args, ctx),
		shutdown: () => events.get("session_shutdown")({ reason: "quit" }, ctx),
	};
}

async function fakeProfile(t, { mode, setup = false } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "cage-host-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const executable = join(dir, "cage executable");
	const config = join(dir, "wired profile.json");
	const log = join(dir, "operations.jsonl");
	const runtime = join(dir, "run");
	const clientPath = setup ? "/fixture home/.local/share/pi-claude-cage/client.mjs" :
		fileURLToPath(new URL("../guest/client.mjs", import.meta.url));
	const fixture = { log, runtime, clientPath, mode };
	writeFileSync(config, JSON.stringify(fixture));
	const profile = { executable, config, clientPath };
	writeFileSync(join(dir, "claude-cage.json"), JSON.stringify(profile));
	const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
	const mock = fileURLToPath(new URL("./mock-cage.mjs", import.meta.url));
	writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(mock)} "$@"\n`, { mode: 0o700 });
	return { dir, profile, runtime, fixture,
		operations: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [],
	};
}

async function mockSocket(t, runtime) {
	const directory = join(runtime, "pi-claude-cage");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const socket = join(directory, "service.sock");
	const retained = new Map();
	const closed = [];
	const calls = [];
	const guest = createGuestServer({
		async getClaudeStatus() { return { available: true, loggedIn: true, subscription: true, plan: "max" }; },
		async discoverClaudeModels() { return [{ ...model, headers: { Authorization: "not-for-host" } }]; },
		modelFromDiscovery: (entry) => entry,
		async *streamClaudeCode(model, context, options) {
			calls.push({ model, context, options });
			const attempt = (retained.get(options.sessionId) ?? 0) + 1;
			retained.set(options.sessionId, attempt);
			const output = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [], usage, timestamp: Date.now(), stopReason: "pending",
			};
			if (context.messages.at(-1).content === "raw guest failure") {
				yield { type: "error", reason: "error", error: {
					...output, stopReason: "error", errorMessage: "rate limit; 503; prompt is too long",
				} };
				return;
			}
			yield { type: "start", partial: output };
			if (context.messages.at(-1).content === "hold") {
				await once(options.signal, "abort");
				return;
			}
			if (attempt === 1) {
				const tool = { type: "toolCall", id: "tool-1", name: "echo", arguments: { phrase: "甲" } };
				const partial = { ...output, content: [tool] };
				yield { type: "toolcall_start", contentIndex: 0, partial };
				yield { type: "toolcall_end", contentIndex: 0, partial, toolCall: tool };
				yield { type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse" } };
			} else {
				const text = `收到：${context.messages.at(-1).content[0].text}`;
				const partial = { ...output, content: [{ type: "text", text }] };
				yield { type: "text_start", contentIndex: 0, partial: { ...output, content: [{ type: "text", text: "" }] } };
				yield { type: "text_delta", contentIndex: 0, partial, delta: text };
				yield { type: "text_end", contentIndex: 0, partial, content: text };
				yield { type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } };
			}
		},
		async closeClaudeProcesses(sessionId) {
			if (sessionId) { closed.push(sessionId); retained.delete(sessionId); }
		},
	});
	const listening = once(guest.server, "listening");
	guest.server.listen(socket);
	await listening;
	await chmod(socket, 0o600);
	t.after(() => guest.stop());
	return { calls, retained, closed };
}

const retry = { enabled: true, maxRetries: 2, baseDelayMs: 10 };

test("no profile or invalid config launches nothing, even for explicit commands", async (t) => {
	const { dir, profile, operations } = await fakeProfile(t);
	const path = join(dir, "claude-cage.json");
	for (const invalid of [undefined, { ...profile, clientPath: "relative" }, { ...profile, token: "no" }]) {
		if (invalid === undefined) await rm(path);
		else writeFileSync(path, JSON.stringify(invalid));
		const app = mount(dir);
		await app.command("status");
		await app.command("setup");
		assert.equal(await app.provider.auth.apiKey.check({}), undefined);
		assert.deepEqual(app.provider.getModels(), []);
		const failed = await app.provider.streamSimple(parseModels([model])[0], normalizeContext({ messages: [user("cage")] })).result();
		assert.equal(failed.stopReason, "error");
		assert.match(failed.errorMessage, /claude-cage.json/);
		await app.shutdown();
	}
	assert.deepEqual(operations(), []);
});

test("one profile carries status, models, two complete Pi turns and one scoped close", { timeout: 15_000 }, async (t) => {
	const { dir, profile, runtime, operations } = await fakeProfile(t);
	const guest = await mockSocket(t, runtime);
	const app = mount(dir);
	assert.deepEqual(app.provider.getModels(), []);
	assert.deepEqual(await app.provider.auth.apiKey.resolve({}), { auth: {}, source: "Cage profile" });
	assert.deepEqual(operations(), [], "config and auth checks must not launch a proxy");
	await app.command("status");
	assert.match(app.notifications.at(-1).message, /subscription max/);
	await app.command("status", "models");
	const picked = app.provider.getModels()[0];
	assert.deepEqual([picked.provider, picked.api, picked.headers], ["claude-cage", "claude-cage", undefined]);
	const image = { type: "image", mimeType: "image/png", data: "AAAA" };
	const context = normalizeContext({
		systemPrompt: "Retain Pi's complete transcript", messages: [user([{ type: "text", text: "第一轮" }, image])],
		tools: [{ name: "echo", description: "Return input", parameters: { type: "object", properties: { phrase: { type: "string" } } } }],
	});
	const options = {
		apiKey: "test-secret", headers: { Authorization: "test-secret" }, env: { CLAUDE_CAGE_CONFIG: "/other" },
		sessionId: "untrusted-session", reasoning: "high", cacheRetention: "short", timeoutMs: 999_000, maxTokens: 400,
		maxRetries: 5, metadata: { secret: "test-secret" },
		onPayload(payload) { return { ...payload, options: { ...payload.options, apiKey: "test-secret" } }; },
	};
	const events = [];
	const first = await app.provider.streamSimple({ ...picked, baseUrl: "https://test-secret", headers: options.headers }, context, {
		...options, onProviderStreamEvent(event) { events.push(event.type); },
	}).result();
	assert.deepEqual(events, ["start", "toolcall_start", "toolcall_end", "done"]);
	assert.equal(first.stopReason, "toolUse");
	assert.deepEqual(first.usage, usage);
	const round = normalizeContext({ messages: [
		...context.messages, first, { role: "toolResult", toolName: "echo", toolCallId: "tool-1", isError: false, timestamp: 8,
			content: [{ type: "text", text: "第二轮" }, image] },
	] });
	const second = await app.provider.stream(picked, round).result();
	assert.equal(second.content[0].text, "收到：第二轮");
	if (process.env.CAGE_CAPTURE_MEDIA) {
		writeFileSync(process.env.CAGE_CAPTURE_MEDIA, JSON.stringify([
			app.notifications.map(({ message }) => message).join("\n"),
			`First turn: ${first.stopReason}\n${JSON.stringify(first.content, null, 2)}`,
			`Second turn: ${second.stopReason}\n${second.content[0].text}\nGuest calls: ${operations().length}`,
		]));
	}
	assert.deepEqual(guest.calls[0].context, context);
	assert.deepEqual(guest.calls[1].context, round);
	assert.equal(guest.calls[0].model.provider, first.provider);
	assert.equal(guest.calls[0].model.api, first.api);
	assert.equal(guest.calls[0].model.baseUrl, "process://claude-code");
	assert.equal(guest.calls[0].model.headers, undefined);
	const { signal, sessionId, ...settings } = guest.calls[0].options;
	assert.deepEqual(settings, { reasoning: "high", cacheRetention: "short", maxTokens: 400, timeoutMs: 180_000 });
	assert.notEqual(sessionId, options.sessionId);
	assert.equal(guest.calls[1].options.sessionId, sessionId);
	const other = mount(dir);
	assert.equal(other.provider.getModels()[0].id, picked.id, "a new session reads its local catalog without probing the guest");
	assert.equal(operations().length, 4);
	await other.provider.streamSimple(picked, context, options).result();
	assert.notEqual(guest.calls[2].options.sessionId, sessionId);
	await app.shutdown();
	await app.shutdown();
	assert.deepEqual(guest.closed, [sessionId]);
	assert(guest.retained.has(guest.calls[2].options.sessionId));
	await other.shutdown();
	assert.deepEqual(guest.closed, [sessionId, guest.calls[2].options.sessionId]);
	assert.equal(guest.retained.size, 0);
	assert(operations().every((entry) => entry.config === profile.config));
	writeFileSync(join(dir, "claude-cage.json"), JSON.stringify({ ...profile, config: join(dir, "other profile.json") }));
	assert.deepEqual(mount(dir).provider.getModels(), [], "catalog does not cross profile boundaries");
});

test("cancel after a partial event becomes aborted; upstream error text cannot trigger retries", async (t) => {
	const { dir, runtime } = await fakeProfile(t);
	const guest = await mockSocket(t, runtime);
	const app = mount(dir);
	const picked = parseModels([model])[0];
	const controller = new AbortController();
	const stream = app.provider.streamSimple(picked, normalizeContext({ messages: [user("hold")] }), { signal: controller.signal });
	const events = [];
	for await (const event of stream) {
		events.push(event.type);
		if (event.type === "start") controller.abort();
	}
	assert.deepEqual(events, ["start", "error"]);
	assert.equal((await stream.result()).stopReason, "aborted");
	assert.equal(guest.calls.length, 1);
	await app.shutdown();
	const another = mount(dir);
	const error = await retryAssistantCall(() => another.provider.streamSimple(picked,
		normalizeContext({ messages: [user("raw guest failure")] })).result(), retry);
	assert.equal(error.stopReason, "error");
	assert.equal(isRetryableAssistantError(error), false);
	assert.equal(isContextOverflow(error, picked.contextWindow), false);
	assert.equal(guest.calls.length, 2);
	await another.shutdown();
});

test("setup probes first, never installs on decline, and sends only root guest files on confirmation", async (t) => {
	const { dir, profile, fixture, operations } = await fakeProfile(t, { setup: true });
	const headless = mount(dir, { hasUI: false });
	await headless.command("setup");
	assert.deepEqual(operations(), []);
	writeFileSync(profile.config, JSON.stringify({ ...fixture, mode: "claude" }));
	let confirmed = 0;
	let consent = false;
	const app = mount(dir, { confirm: async () => { confirmed++; return consent; } });
	await app.command("setup");
	assert.equal(confirmed, 0);
	assert.match(app.notifications.at(-1).message, /claude --version/);
	writeFileSync(profile.config, JSON.stringify(fixture));
	await app.command("setup");
	assert.equal(confirmed, 1);
	assert.deepEqual(operations().map((entry) => entry.phase), ["preflight", "preflight"]);
	consent = true;
	await app.command("setup");
	assert.equal(confirmed, 2);
	assert.deepEqual(operations().map((entry) => entry.phase), ["preflight", "preflight", "preflight", "install"]);
	assert.deepEqual(operations().at(-1).files.sort(), [
		"client.mjs", "package-lock.json", "package.json", "pi-claude-cage.service", "pi-claude-cage.socket", "protocol.mjs", "service.mjs",
	]);
	assert.match(app.notifications.at(-1).message, /bridge installed/);
	await app.shutdown();
});

test("transport bounds startup, response, stdout preamble, frames and request size", { timeout: 10_000 }, async (t) => {
	const { profile, fixture, operations } = await fakeProfile(t);
	for (const [mode, message] of [
		["hang-ready", /ready before its deadline/], ["hang-response", /complete before its deadline/],
		["preamble-limit", /preamble is too large/], ["response-limit", /response line is too large/],
		["wrong-id", /did not match this request/],
	]) {
		writeFileSync(profile.config, JSON.stringify({ ...fixture, mode }));
		await assert.rejects(requestCage(profile, { op: "status" }, { startupMs: 350, responseMs: 150 }), message);
	}
	const count = operations().length;
	await assert.rejects(requestCage(profile, {
		op: "turn", sessionId: "test", model, options: {}, context: { messages: [user("x".repeat(MAX_LINE_BYTES))] },
	}), /Protocol line is too large/);
	assert.equal(operations().length, count, "oversized requests are rejected before launch");
	const controller = new AbortController();
	controller.abort(new Error("already cancelled"));
	await assert.rejects(requestCage(profile, { op: "status" }, { signal: controller.signal }), /already cancelled/);
	assert.equal(operations().length, count);
});

test("disconnect and retryable guest transport error submit only once with Pi retry enabled", { timeout: 15_000 }, async (t) => {
	for (const mode of ["disconnect", "turn-error"]) {
		const { dir, operations } = await fakeProfile(t, { mode });
		const app = mount(dir);
		const picked = parseModels([model])[0];
		const error = await retryAssistantCall(() => app.provider.streamSimple({
			...picked, baseUrl: "https://secret-marker", headers: { Authorization: "secret-marker" },
		}, normalizeContext({ messages: [user("one submission")] }), {
			apiKey: "secret-marker", env: { TOKEN: "secret-marker" }, headers: { Authorization: "secret-marker" },
			sessionId: "secret-marker", timeoutMs: 1_000, maxRetries: 2,
		}).result(), retry);
		assert.equal(error.stopReason, "error");
		assert.equal(isRetryableAssistantError(error), false, error.errorMessage);
		assert.doesNotMatch(error.errorMessage, /503|socket hang up|connection closed/i);
		const sent = operations().filter((entry) => entry.request).map((entry) => entry.request);
		assert.deepEqual(sent.map((request) => request.op), ["turn"]);
		assert.doesNotMatch(JSON.stringify(sent[0]), /secret-marker/);
		assert.deepEqual(sent[0].options, { timeoutMs: 1_000 });
		await app.shutdown();
		assert.deepEqual(operations().filter((entry) => entry.request).map((entry) => entry.request.op), ["turn", "close"]);
		assert(operations().some((entry) => entry.phase === "input closed"), "close terminal response ends stdin cleanly");
	}
});

test("real isolated Pi with auto-retry enabled does not repeat a submitted turn", { timeout: 20_000 }, async (t) => {
	const { dir, profile, fixture, operations } = await fakeProfile(t, { mode: "disconnect" });
	saveCatalog(dir, loadProfile(dir), parseModels([model]));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ quietStartup: true, retry }));
	const opts = {
		cwd: dir, encoding: "utf8", timeout: 12_000,
		env: {
			PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: dir, TEST_HOST_SECRET: "test-only",
			PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1",
		},
	};
	const args = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
		"--no-session", "--offline", "-e", extension];
	function runPi(extra) {
		const command = promisify(execFile)(piBinary, [...args, ...extra], opts);
		command.child.stdin.end();
		return command;
	}
	const listed = await runPi(["--list-models", "claude-cage"]);
	assert.match(listed.stdout, /claude-cage\s+claude-mock/);
	assert.deepEqual(operations(), [], "real Pi startup does not probe the guest even with a cached model");
	for (const [mode, diagnostic] of [
		["disconnect", /Claude Cage.*disconnected.*stderr/i],
		["turn-error", /Claude Cage.*Automatic replay is disabled/i],
	]) {
		writeFileSync(profile.config, JSON.stringify({ ...fixture, mode }));
		const before = operations().length;
		let result;
		try {
			result = await runPi(["--model", "claude-cage/claude-mock", "-p", "Do not retry"]);
		} catch (error) {
			assert.equal(error.code, 1, JSON.stringify({
				stdout: error.stdout, stderr: error.stderr, signal: error.signal, operations: operations().slice(before),
			}));
			result = error;
		}
		assert.match(`${result.stdout}\n${result.stderr}`, diagnostic);
		const requests = operations().slice(before).filter((entry) => entry.request).map((entry) => entry.request);
		assert.deepEqual(requests.map((request) => request.op), ["turn", "close"]);
		assert.equal(requests[0].context.messages[0].role, "system");
	}
});

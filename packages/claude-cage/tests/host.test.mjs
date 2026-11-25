import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const { saveCatalog } = await import("../src/profile.ts");
const { parseModels } = await import("../src/provider.ts");
const { normalizeContext, isRetryableAssistantError, retryAssistantCall } = await import("@earendil-works/pi-ai");

const model = {
	id: "claude-mock", provider: "upstream", api: "upstream-api", baseUrl: "process://upstream",
	name: "Mock Claude", input: ["text", "image"], reasoning: true,
	contextWindow: 200_000, maxTokens: 16_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const user = (content) => ({ role: "user", content, timestamp: 5 });

async function waitFor(check, message, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = check();
		if (value) return value;
		if (Date.now() >= deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

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
	const servicePath = setup ? "/fixture home/.local/share/pi-claude-cage/service.mjs" : "/fixture guest/service.mjs";
	const fixture = { log, servicePath, mode };
	writeFileSync(config, JSON.stringify(fixture));
	const profile = { executable, config, servicePath };
	writeFileSync(join(dir, "claude-cage.json"), JSON.stringify(profile));
	const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
	const mock = fileURLToPath(new URL("./mock-cage.mjs", import.meta.url));
	writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(mock)} "$@"\n`, { mode: 0o700 });
	return {
		dir, profile, fixture,
		operations: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [],
	};
}

test("model parsing preserves cache metadata only for adaptive-thinking models", () => {
	const safe = parseModels([{
		...model,
		id: "claude-safe",
		promptCache: { short: 300, long: 3600 },
		compat: { forceAdaptiveThinking: true },
	}])[0];
	assert.deepEqual(safe.promptCache, { long: 3600 });
	assert.equal(safe.compat.forceAdaptiveThinking, true);

	const unsafe = parseModels([{
		...model,
		id: "claude-unsafe",
		promptCache: { short: 300, long: 3600 },
	}])[0];
	assert.equal(unsafe.promptCache, undefined);
	assert.equal(unsafe.compat, undefined);

	assert.throws(() => parseModels([{
		...model,
		id: "claude-invalid-cache",
		promptCache: { short: 0, long: 3600 },
		compat: { forceAdaptiveThinking: true },
	}]), /Invalid or duplicate model/);
});

test("invalid profile launches nothing and an old clientPath profile gives an exact migration error", async (t) => {
	const { dir, profile, operations } = await fakeProfile(t);
	const path = join(dir, "claude-cage.json");
	for (const invalid of [undefined, { executable: profile.executable, config: profile.config, clientPath: "/old/client.mjs" },
		{ ...profile, servicePath: "relative" }]) {
		if (invalid === undefined) await rm(path);
		else writeFileSync(path, JSON.stringify(invalid));
		const app = mount(dir);
		await app.command("status");
		const failed = await app.provider.streamSimple(parseModels([model])[0], normalizeContext({ messages: [user("x")] })).result();
		assert.equal(failed.stopReason, "error");
		if (invalid && "clientPath" in invalid) assert.match(failed.errorMessage, /replace clientPath with .*servicePath/i);
		await app.shutdown();
	}
	assert.deepEqual(operations(), []);
});

test("one Pi runtime keeps one Cage process for status, models, and multiple transcript-synchronized turns", async (t) => {
	const { dir, profile, operations } = await fakeProfile(t);
	const app = mount(dir);
	assert.deepEqual(app.provider.getModels(), []);
	await app.command("status");
	assert.match(app.notifications.at(-1).message, /subscription max/);
	await app.command("status", "models");
	const picked = app.provider.getModels()[0];
	const image = { type: "image", mimeType: "image/png", data: "A".repeat(4096) };
	const context = normalizeContext({ messages: [user([{ type: "text", text: "第一轮" }, image])] });
	const events = [];
	const first = await app.provider.streamSimple(picked, context, {
		reasoning: "high", cacheRetention: "short", timeoutMs: 9_999_999, maxTokens: 400,
		onProviderStreamEvent(event) { events.push(event); },
	}).result();
	assert.equal(first.stopReason, "toolUse");
	assert.deepEqual(events.map(({ type }) => type), ["start", "toolcall_start", "toolcall_end", "done"]);
	assert(events.slice(0, -1).every(({ partial }) => partial === events[0].partial), "partial identity must be shared");
	const round = normalizeContext({ messages: [
		...context.messages, first,
		{ role: "toolResult", toolName: "echo", toolCallId: "tool-1", isError: false, timestamp: 8,
			content: [{ type: "text", text: "第二轮" }] },
	] });
	const second = await app.provider.streamSimple(picked, round).result();
	assert.equal(second.content[0].text, "收到：第二轮");
	const changed = normalizeContext({ messages: [user("changed history")] });
	assert.equal((await app.provider.streamSimple(picked, changed).result()).stopReason, "stop");
	if (process.env.CAGE_CAPTURE_MEDIA) {
		writeFileSync(process.env.CAGE_CAPTURE_MEDIA, JSON.stringify([
			app.notifications.map(({ message }) => message).join("\n"),
			`First turn: ${first.stopReason}\n${JSON.stringify(first.content, null, 2)}`,
			`Second turn: ${second.stopReason}\n${second.content[0].text}\nOne persistent Cage process`,
		]));
	}

	const log = operations();
	assert.equal(log.filter(({ phase }) => phase === "proxy").length, 1);
	assert.deepEqual(log.filter(({ phase }) => phase === "turn").map(({ context }) => context.messages),
		[context.messages, round.messages, changed.messages]);
	const wire = log.filter(({ phase, op }) => phase === "wire" && op === "turn");
	assert.deepEqual(wire.map(({ mode }) => mode), ["full", "append", "full"]);
	assert.deepEqual(wire.map(({ containsImage }) => containsImage), [true, false, false]);
	assert(wire[1].transcriptBytes < wire[0].transcriptBytes, "append must not repeat the inline image");
	assert.equal(log.find(({ phase }) => phase === "turn").options.timeoutMs, 1_200_000);
	assert(log.every(({ config }) => config === profile.config));
	await app.shutdown();
	assert(log.filter(({ phase }) => phase === "closed").length <= 1);
});

test("a real turn preempts an in-flight cache warm and the warm usage remains auxiliary-shaped", async (t) => {
	const { dir, operations } = await fakeProfile(t);
	const app = mount(dir);
	t.after(() => app.shutdown());
	await app.command("status", "models");
	const picked = app.provider.getModels()[0];
	assert.deepEqual(picked.promptCache, { long: 3600 });
	assert.equal(picked.compat.forceAdaptiveThinking, true);

	const warmContext = normalizeContext({ messages: [user("hold")] });
	const warming = app.provider.streamSimple(picked, warmContext, {
		disableContinuation: true,
		cacheRetention: "long",
		maxTokens: 1,
	}).result();
	await waitFor(() => operations().find(({ phase, context }) =>
		phase === "turn" && context.messages.at(-1).content === "hold"), "warm turn did not start");

	const realContext = normalizeContext({ messages: [user([{ type: "text", text: "real" }])] });
	const real = app.provider.streamSimple(picked, realContext, { cacheRetention: "long" }).result();
	const [warmMessage, realMessage] = await Promise.all([warming, real]);
	assert.equal(warmMessage.stopReason, "aborted");
	assert.equal(realMessage.stopReason, "stop");
	assert.equal(realMessage.content[0].text, "收到：real");

	const turns = operations().filter(({ phase }) => phase === "turn");
	assert.equal(turns[0].context.messages.at(-1).content, "hold");
	assert.equal(turns[1].context.messages.at(-1).content[0].text, "real");
	assert.equal(turns[0].options.maxTokens, 1);
	assert.equal(turns[1].options.maxTokens, undefined);
	assert.ok(turns.every(({ options }) => options.cacheRetention === "long"));

	const refreshed = await app.provider.streamSimple(picked, normalizeContext({
		messages: [user([{ type: "text", text: "refresh" }])],
	}), {
		disableContinuation: true,
		cacheRetention: "long",
		maxTokens: 1,
	}).result();
	assert.equal(refreshed.stopReason, "stop");
	assert.equal(refreshed.usage.cacheRead, 128);
	assert.equal(refreshed.usage.cacheWrite, 0);
});

test("PI_CACHE_RETENTION=long reaches the guest when Pi omits cacheRetention", async (t) => {
	const original = process.env.PI_CACHE_RETENTION;
	process.env.PI_CACHE_RETENTION = "long";
	t.after(() => {
		if (original === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = original;
	});
	const { dir, operations } = await fakeProfile(t);
	const app = mount(dir);
	t.after(() => app.shutdown());
	await app.command("status", "models");
	const picked = app.provider.getModels()[0];
	await app.provider.streamSimple(picked, normalizeContext({ messages: [user([{ type: "text", text: "short override" }])] }), {
		env: { PI_CACHE_RETENTION: "short" },
	}).result();
	assert.equal(operations().findLast(({ phase }) => phase === "turn").options.cacheRetention, "short");
	await app.provider.streamSimple(picked, normalizeContext({ messages: [user([{ type: "text", text: "long environment" }])] })).result();
	assert.equal(operations().findLast(({ phase }) => phase === "turn").options.cacheRetention, "long");
});

test("control requests preempt an in-flight cache warm", async (t) => {
	const { dir, operations } = await fakeProfile(t);
	const app = mount(dir);
	t.after(() => app.shutdown());
	await app.command("status", "models");
	const picked = app.provider.getModels()[0];
	const warming = app.provider.streamSimple(picked, normalizeContext({ messages: [user("hold")] }), {
		disableContinuation: true, cacheRetention: "long", maxTokens: 1,
	}).result();
	await waitFor(() => operations().some(({ phase, context }) =>
		phase === "turn" && context.messages.at(-1).content === "hold"), "warm turn did not start");
	await app.command("status");
	assert.equal((await warming).stopReason, "aborted");
	assert.ok(operations().findLast(({ phase }) => phase === "status"));
	assert.equal(app.notifications.at(-1).type, "info");
});

test("warming skips active control and setup operations", async (t) => {
	const slow = await fakeProfile(t, { mode: "slow-status" });
	saveCatalog(slow.dir, slow.profile, [model]);
	const statusApp = mount(slow.dir);
	t.after(() => statusApp.shutdown());
	const status = statusApp.command("status");
	await waitFor(() => slow.operations().some(({ phase }) => phase === "status"), "slow status did not start");
	const skippedDuringStatus = await statusApp.provider.streamSimple(statusApp.provider.getModels()[0],
		normalizeContext({ messages: [user([{ type: "text", text: "status warm" }])] }), {
			disableContinuation: true, cacheRetention: "long", maxTokens: 1,
		}).result();
	assert.equal(skippedDuringStatus.stopReason, "aborted");
	await status;
	assert.equal(slow.operations().filter(({ phase }) => phase === "turn").length, 0);

	const setupFixture = await fakeProfile(t, { setup: true });
	saveCatalog(setupFixture.dir, setupFixture.profile, [model]);
	const confirmationEntered = Promise.withResolvers();
	const confirmationRelease = Promise.withResolvers();
	const setupApp = mount(setupFixture.dir, { confirm: async () => {
		confirmationEntered.resolve();
		await confirmationRelease.promise;
		return false;
	} });
	t.after(() => setupApp.shutdown());
	const setup = setupApp.command("setup");
	await confirmationEntered.promise;
	const skippedDuringSetup = await setupApp.provider.streamSimple(setupApp.provider.getModels()[0],
		normalizeContext({ messages: [user([{ type: "text", text: "setup warm" }])] }), {
			disableContinuation: true, cacheRetention: "long", maxTokens: 1,
	}).result();
	assert.equal(skippedDuringSetup.stopReason, "aborted");
	confirmationRelease.resolve();
	await setup;
	assert.equal(setupFixture.operations().filter(({ phase }) => phase === "turn").length, 0);
});

test("warming skips active real turns and a newer warm replaces an older warm", async (t) => {
	const { dir, operations } = await fakeProfile(t);
	const app = mount(dir);
	t.after(() => app.shutdown());
	await app.command("status", "models");
	const picked = app.provider.getModels()[0];
	const controller = new AbortController();
	const real = app.provider.streamSimple(picked, normalizeContext({ messages: [user("hold")] }), {
		signal: controller.signal, cacheRetention: "long",
	}).result();
	await waitFor(() => operations().some(({ phase, context }) =>
		phase === "turn" && context.messages.at(-1).content === "hold"), "real turn did not start");
	const skipped = await app.provider.streamSimple(picked, normalizeContext({ messages: [user([{ type: "text", text: "skip warm" }])] }), {
		disableContinuation: true, cacheRetention: "long", maxTokens: 1,
	}).result();
	assert.equal(skipped.stopReason, "aborted");
	assert.equal(operations().filter(({ phase }) => phase === "turn").length, 1);
	controller.abort(new Error("release real turn"));
	assert.equal((await real).stopReason, "aborted");

	const firstWarm = app.provider.streamSimple(picked, normalizeContext({ messages: [user("hold")] }), {
		disableContinuation: true, cacheRetention: "long", maxTokens: 1,
	}).result();
	await waitFor(() => operations().filter(({ phase, context }) =>
		phase === "turn" && context.messages.at(-1).content === "hold").length === 2, "replacement fixture warm did not start");
	const replacement = app.provider.streamSimple(picked, normalizeContext({ messages: [user([{ type: "text", text: "replacement warm" }])] }), {
		disableContinuation: true, cacheRetention: "long", maxTokens: 1,
	}).result();
	assert.equal((await firstWarm).stopReason, "aborted");
	assert.equal((await replacement).stopReason, "stop");
	assert.equal(operations().findLast(({ phase }) => phase === "turn").context.messages.at(-1).content[0].text, "replacement warm");
});

test("a separate Pi runtime owns a separate Cage process and upstream session", async (t) => {
	const { dir, operations } = await fakeProfile(t);
	saveCatalog(dir, JSON.parse(readFileSync(join(dir, "claude-cage.json"), "utf8")), [model]);
	const left = mount(dir);
	const right = mount(dir);
	const picked = left.provider.getModels()[0];
	await left.provider.streamSimple(picked, normalizeContext({ messages: [user("left")] })).result();
	await right.provider.streamSimple(picked, normalizeContext({ messages: [user("right")] })).result();
	const log = operations();
	assert.equal(log.filter(({ phase }) => phase === "proxy").length, 2);
	assert.equal(new Set(log.filter(({ phase }) => phase === "turn").map(({ sessionId }) => sessionId)).size, 2);
	await left.shutdown();
	await right.shutdown();
});

test("an existing Pi transcript continues after reload through a new full-transfer connection", async (t) => {
	const { dir, operations } = await fakeProfile(t);
	const profile = JSON.parse(readFileSync(join(dir, "claude-cage.json"), "utf8"));
	saveCatalog(dir, profile, [model]);
	const initial = normalizeContext({ messages: [user([
		{ type: "text", text: "before reload" },
		{ type: "image", mimeType: "image/png", data: "fixture-image" },
	])] });

	const beforeReload = mount(dir);
	const picked = beforeReload.provider.getModels()[0];
	const toolTurn = await beforeReload.provider.streamSimple(picked, initial).result();
	assert.equal(toolTurn.stopReason, "toolUse");
	await beforeReload.shutdown();

	const continuedContext = normalizeContext({ messages: [
		...initial.messages,
		toolTurn,
		{
			role: "toolResult", toolName: "echo", toolCallId: toolTurn.content[0].id,
			isError: false, timestamp: 8, content: [{ type: "text", text: "after reload" }],
		},
	] });
	const afterReload = mount(dir);
	const continued = await afterReload.provider.streamSimple(afterReload.provider.getModels()[0], continuedContext).result();
	assert.equal(continued.stopReason, "stop");
	assert.equal(continued.content[0].text, "收到：after reload");

	const log = operations();
	assert.equal(log.filter(({ phase }) => phase === "proxy").length, 2);
	assert.deepEqual(log.filter(({ phase, op }) => phase === "wire" && op === "turn").map(({ mode }) => mode),
		["full", "full"]);
	assert.deepEqual(log.filter(({ phase }) => phase === "turn").at(-1).context.messages, continuedContext.messages);
	assert.equal(new Set(log.filter(({ phase }) => phase === "turn").map(({ sessionId }) => sessionId)).size, 2);
	await afterReload.shutdown();
});

test("clean cancellation remains usable and upstream-looking error text cannot trigger Pi retry", async (t) => {
	const { dir, operations } = await fakeProfile(t);
	saveCatalog(dir, JSON.parse(readFileSync(join(dir, "claude-cage.json"), "utf8")), [model]);
	const app = mount(dir);
	const picked = app.provider.getModels()[0];
	const controller = new AbortController();
	const stream = app.provider.streamSimple(picked, normalizeContext({ messages: [user("hold")] }), { signal: controller.signal });
	const eventTypes = [];
	let concurrent;
	for await (const event of stream) {
		eventTypes.push(event.type);
		if (event.type === "start") {
			concurrent = app.command("status");
			await concurrent;
			assert.match(app.notifications.at(-1).message, /operation is in progress/);
			controller.abort(new Error("user cancelled"));
		}
	}
	assert.deepEqual(eventTypes, ["start", "error"]);
	assert.equal((await stream.result()).stopReason, "aborted");

	const error = await retryAssistantCall(() => app.provider.streamSimple(picked,
		normalizeContext({ messages: [user("raw guest failure")] })).result(), { enabled: true, maxRetries: 2, baseDelayMs: 1 });
	assert.equal(error.stopReason, "error");
	assert.equal(isRetryableAssistantError(error), false);
	assert.equal(operations().filter(({ phase }) => phase === "turn").length, 2);
	await app.shutdown();
});

test("fatal disconnect is red-error text, does not relaunch, and requires reload", async (t) => {
	const { dir, operations } = await fakeProfile(t, { mode: "disconnect" });
	saveCatalog(dir, JSON.parse(readFileSync(join(dir, "claude-cage.json"), "utf8")), [model]);
	const app = mount(dir);
	const picked = app.provider.getModels()[0];
	const first = await app.provider.streamSimple(picked, normalizeContext({ messages: [user("once")] })).result();
	assert.equal(first.stopReason, "error");
	assert.match(first.errorMessage, /^Claude Cage connection failed and is closed\./);
	assert.match(first.errorMessage, /Run \/reload/);
	const second = await app.provider.streamSimple(picked, normalizeContext({ messages: [user("twice")] })).result();
	assert.equal(second.errorMessage, first.errorMessage);
	assert.equal(operations().filter(({ phase }) => phase === "proxy").length, 1);
	await app.command("status");
	assert.equal(app.notifications.at(-1).type, "error");
	assert.match(app.notifications.at(-1).message, /\/reload/);
	await app.shutdown();
});

test("malformed startup or response data latches the connection fatal without relaunch", async (t) => {
	for (const mode of ["wrong-id", "preamble-limit"]) {
		const { dir, operations } = await fakeProfile(t, { mode });
		const app = mount(dir);
		await app.command("status");
		assert.equal(app.notifications.at(-1).type, "error");
		assert.match(app.notifications.at(-1).message, /^Claude Cage connection failed and is closed\./);
		await app.command("status");
		assert.match(app.notifications.at(-1).message, /Run \/reload/);
		assert.equal(operations().filter(({ phase }) => phase === "proxy").length, 1);
		await app.shutdown();
	}
});

test("setup probes, confirms, and sends only v2 guest files", async (t) => {
	const { dir, operations } = await fakeProfile(t, { setup: true });
	const declined = mount(dir, { confirm: async () => false });
	await declined.command("setup");
	assert.deepEqual(operations().map(({ phase }) => phase), ["preflight"]);
	const confirmed = mount(dir, { confirm: async () => true });
	await confirmed.command("setup");
	const install = operations().find(({ phase }) => phase === "install");
	assert.deepEqual(install.files.sort(), ["package-lock.json", "package.json", "protocol.mjs", "service.mjs"]);
	assert.match(confirmed.notifications.at(-1).message, /installed/);
});

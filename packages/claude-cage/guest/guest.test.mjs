import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createGuestServer } from "./service.mjs";
import { isTerminal } from "./protocol.mjs";
import { startFixtureUpstream, toolUse } from "./fixtures/upstream.mjs";

const clientPath = fileURLToPath(new URL("./client.mjs", import.meta.url));
const hostModel = {
  id: "claude-opus-5-5", provider: "host-cage", api: "host-cage-stream-json", name: "Opus",
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, input: ["text", "image"],
  baseUrl: "http://example.invalid/host", headers: { Authorization: "untrusted" },
  contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true,
};
const user = (content) => ({ role: "user", content, timestamp: 0 });
const turn = (sessionId, text, options) => ({
  id: `${sessionId}:${text}`, op: "turn", sessionId, options,
  model: hostModel, context: { messages: [user(text)] },
});

async function runtime(t) {
  const root = await mkdtemp(join(tmpdir(), "claude-cage-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "pi-claude-cage");
  await mkdir(directory, { mode: 0o700 });
  return { root, directory, socket: join(directory, "service.sock") };
}

async function openClient(t, root, request, client = clientPath) {
  const child = spawn(process.execPath, [client], {
    cwd: "/tmp", env: { XDG_RUNTIME_DIR: root }, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, '{"type":"ready","version":1}', stderr);
  if (request) {
    // The operation can arrive fragmented, even within a multibyte character.
    const bytes = Buffer.from(`${JSON.stringify(request)}\n`);
    const offset = bytes.indexOf(0xe7);
    if (offset >= 0) child.stdin.write(bytes.subarray(0, offset + 1));
    child.stdin.write(offset < 0 ? bytes : bytes.subarray(offset + 1));
  }
  return {
    child,
    async next() {
      const item = await lines.next();
      assert.equal(item.done, false, stderr);
      const frame = JSON.parse(item.value);
      assert.equal(frame.id, request?.id ?? null);
      return frame;
    },
    async result() {
      const frames = [];
      do { frames.push(await this.next()); } while (!isTerminal(frames.at(-1)));
      assert.equal((await lines.next()).done, true, "only one terminal response is allowed");
      assert.deepEqual(await exited, [0, null], stderr);
      assert.equal(stderr, "");
      return frames;
    },
  };
}

const last = async (client) => (await client.result()).at(-1);

async function mockGuest(t) {
  const { root, socket } = await runtime(t);
  const cache = new Map();
  const calls = [];
  const guest = createGuestServer({
    async getClaudeStatus() {
      return { available: true, loggedIn: true, subscription: true, plan: "pro", detail: "not for hosts" };
    },
    async discoverClaudeModels() { return [hostModel]; },
    modelFromDiscovery(model) { return model; },
    async *streamClaudeCode(model, context, options) {
      calls.push({ model, context, options });
      const count = (cache.get(options.sessionId) ?? 0) + 1;
      cache.set(options.sessionId, count);
      yield { type: "start" };
      const text = context.messages[0].content;
      if (text === "wait") await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
      if (text === "missing terminal") return;
      if (text === "billing") {
        yield { type: "error", error: { errorMessage: "Claude Code billing: usage credits" } };
        return;
      }
      yield { type: "done", message: { count, text } };
    },
    async closeClaudeProcesses(sessionId) {
      if (sessionId === undefined) cache.clear();
      else cache.delete(sessionId);
    },
  });
  guest.server.listen(socket);
  await once(guest.server, "listening");
  await chmod(socket, 0o600);
  t.after(guest.stop);
  return { root, cache, calls, request: (request) => openClient(t, root, request) };
}

test("stdio-to-socket handles metadata and retains only each successful session", { timeout: 10_000 }, async (t) => {
  const { request, cache, calls } = await mockGuest(t);
  assert.deepEqual((await last(await request({ id: "status", op: "status" }))).value,
    { available: true, loggedIn: true, subscription: true, plan: "pro" });
  assert.deepEqual((await last(await request({ id: "models", op: "models" }))).value, [hostModel]);

  const client = await request(turn("a", "第一轮", {
    reasoning: "high", timeoutMs: 60_000, maxTokens: 400, cacheRetention: "short",
    sessionId: "b", upstreamUrl: "http://example.invalid", apiKey: "key", cwd: "/other", env: { SOME_SECRET: "secret" },
  }));
  const events = await client.result();
  assert.deepEqual(events.map((frame) => frame.event.type), ["start", "done"]);
  assert.deepEqual(events[1].event.message, { count: 1, text: "第一轮" });
  const { headers: _headers, ...metadata } = hostModel;
  assert.deepEqual(calls[0].model, { ...metadata, baseUrl: "process://claude-code" });
  const { signal, ...options } = calls[0].options;
  assert.equal(signal.aborted, false);
  assert.deepEqual(options, { sessionId: "a", reasoning: "high", timeoutMs: 60_000, maxTokens: 400, cacheRetention: "short" });

  assert.equal((await last(await request(turn("b", "new")))).event.message.count, 1);
  assert.equal((await last(await request(turn("a", "again")))).event.message.count, 2);
  assert.equal((await last(await request({ id: "close", op: "close", sessionId: "a" }))).value, null);
  assert.deepEqual([...cache], [["b", 1]]);
  assert.equal((await last(await request(turn("a", "fresh")))).event.message.count, 1);
});

test("cancel, EOF, timeout, upstream failure and close clear an interrupted session", { timeout: 10_000 }, async (t) => {
  const { request, cache, calls } = await mockGuest(t);
  await last(await request(turn("other", "keep")));
  for (const mode of ["cancel", "eof", "close", "timeout"]) {
    const frame = turn(mode, "wait", mode === "timeout" ? { timeoutMs: 300 } : undefined);
    const stalled = await request(frame);
    assert.equal((await stalled.next()).event.type, "start");
    assert(cache.has(mode));
    if (mode === "cancel") {
      const overlap = await last(await request(turn(mode, "overlapping")));
      assert.match(overlap.message, /active operation/);
      assert(cache.has(mode));
      stalled.child.stdin.write(`${JSON.stringify({ id: frame.id, type: "cancel" })}\n`);
    }
    if (mode === "eof") stalled.child.stdin.end();
    if (mode === "close") {
      assert.equal((await last(await request({ id: "close", op: "close", sessionId: mode }))).value, null);
    }
    assert.equal((await last(stalled)).type, "error");
    assert.equal(calls.at(-1).options.signal.aborted, true);
    assert.deepEqual([...cache], [["other", 1]]);
  }
  const failed = await last(await request(turn("billing", "billing")));
  assert.equal(failed.event.type, "error");
  assert.match(failed.event.error.errorMessage, /billing/);
  assert.match((await last(await request(turn("lost", "missing terminal")))).message, /without a terminal event/);
  assert.match((await last(await request({ id: 42, op: "close" }))).message, /requires a sessionId/);
  assert.deepEqual([...cache], [["other", 1]]);
});

test("ready remains the first line when no private socket is available", { timeout: 5_000 }, async (t) => {
  const { root } = await runtime(t);
  const client = await openClient(t, root, { id: 42, op: "status" });
  assert.match((await last(client)).message, /socket unavailable/);
});

const installed = process.env.PI_CLAUDE_CAGE_TEST_INSTALL_DIR;
test("installed upstream requires a relayed turn and replays Pi tool results", {
  skip: !installed, timeout: 25_000,
}, async (t) => {
  const { root, directory, socket } = await runtime(t);
  const { requests, port } = await startFixtureUpstream(t);
  const executable = join(root, "fake-claude.mjs");
  const fixture = await readFile(new URL("./fixtures/claude-cli.mjs", import.meta.url), "utf8");
  await writeFile(executable, `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 });
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const redirect = fileURLToPath(new URL("./fixtures/redirect-upstream.mjs", import.meta.url));
  const service = spawn("systemd-socket-activate", [
    "--listen", socket, "--setenv=HOME", "--setenv=PI_CLAUDE_CODE_COMMAND",
    "--setenv=PI_CLAUDE_CAGE_FIXTURE_PORT", "--setenv=ANTHROPIC_API_KEY=fixture-only",
    "--setenv=GITHUB_TOKEN=fixture-only", "--setenv=PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS=1",
    join(installed, "node"), "--experimental-transform-types", "--import", redirect, join(installed, "service.mjs"),
  ], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: home, PI_CLAUDE_CODE_COMMAND: executable, PI_CLAUDE_CAGE_FIXTURE_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = once(service, "exit");
  let stderr = "";
  service.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => { service.kill(); await exited; });

  async function waitFor(check, what) {
    for (let attempts = 0; attempts < 500; attempts++) {
      if (await check()) return;
      assert.equal(service.exitCode, null, stderr);
      await delay(10);
    }
    assert.fail(`${what}\n${stderr}`);
  }

  await waitFor(() => stat(socket).catch(() => null), "Socket was not created");
  await chmod(socket, 0o600);
  const request = (frame) => openClient(t, root, frame, join(installed, "client.mjs"));
  const status = await last(await request({ id: "status", op: "status" }));
  assert.deepEqual(status.value, { available: true, loggedIn: true, subscription: true, plan: "max" }, stderr);
  const catalog = await last(await request({ id: "models", op: "models" }));
  assert.equal(catalog.value?.[0].id, "claude-haiku-4-5-20251001", catalog.message ?? stderr);
  const model = { ...catalog.value[0], provider: hostModel.provider, api: hostModel.api };
  const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
  // Pi 1.6 attaches prompt and tool declarations to the leading system message.
  const system = {
    role: "system", content: "Use the echo tool.", timestamp: 0,
    toolsAdded: [{ name: "echo", description: "Echo a string", parameters: schema }],
  };
  const input = (sessionId, id, history = [user(id)]) => ({
    ...turn(sessionId, id), model, context: { messages: [system, ...history] },
    options: { env: { PI_CLAUDE_CODE_COMMAND: "/not/allowed", UNTRUSTED: "ignore", PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS: "1" } },
  });

  async function calls() {
    return (await readFile(join(directory, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  }

  function assertRelayed(frame, reason, index) {
    assert.equal(frame.event?.type, "done", frame.event?.error?.errorMessage ?? frame.message ?? stderr);
    assert.equal(frame.event.reason, reason);
    const { message } = frame.event;
    assert.equal(message.provider, hostModel.provider);
    assert.equal(message.api, hostModel.api);
    assert.equal(message.model, model.id);
    const diagnostics = message.diagnostics.filter((entry) => entry.type === "claude-code.turn-relay");
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0].details, {
      upstreamRequests: 1, blockedRequests: 0, requestId: requests[index].id,
    });
    assert.equal(message.responseId, `msg_${requests[index].id}`);
    return message;
  }

  const initial = user("use a tool");
  const first = await (await request(input("one", "use a tool", [initial]))).result();
  const toolCall = { type: "toolCall", id: toolUse.id, name: "echo", arguments: toolUse.input };
  assert.deepEqual(first.map(({ event }) => event?.type), ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
  assert.deepEqual(first[3].event.toolCall, toolCall);
  const toolTurn = assertRelayed(first.at(-1), "toolUse", 0);
  assert.deepEqual(toolTurn.content, [toolCall]);
  const { body } = requests[0];
  assert.equal(body.system, system.content);
  assert.deepEqual(body.tools, [{ name: toolUse.name, description: "Echo a string", input_schema: schema }]);
  assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: initial.content }] }]);
  const toolWorker = (await calls())[0].pid;
  assert.throws(() => process.kill(toolWorker, 0), { code: "ESRCH" });

  const result = (text) => ({
    role: "toolResult", toolCallId: toolTurn.content[0].id, toolName: "echo", timestamp: 1, isError: false,
    content: [{ type: "text", text }],
  });
  const history = [initial, toolTurn, result("real Pi tool output")];
  const second = assertRelayed(await last(await request(input("one", "continue", history))), "stop", 1);
  assert.deepEqual(second.content, [{ type: "text", text: "loopback answer: tool result" }]);
  const nativeResult = {
    type: "tool_result", tool_use_id: toolUse.id, content: "real Pi tool output", is_error: false,
  };
  assert.deepEqual(requests[1].body.messages, [
    body.messages[0], { role: "assistant", content: [toolUse] }, { role: "user", content: [nativeResult] },
  ]);
  const { usage } = second;
  assert.deepEqual([usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens], [7, 3, 11, 2, 23]);
  assert(usage.cost.total > 0, "keep upstream's list-price accounting for the discovered model");
  const coldReplay = (await calls()).slice(1);
  assert.deepEqual(coldReplay.map(({ query }) => query), [false, false, true]);
  const warmWorker = coldReplay[0].pid;
  assert.notEqual(warmWorker, toolWorker);
  assert(coldReplay.every(({ pid }) => pid === warmWorker));

  const linear = [...history, second, user("linear")];
  const third = assertRelayed(await last(await request(input("one", "linear", linear))), "stop", 2);
  assert.equal((await calls()).length, 5, "warm continuation sends only the new user frame");
  assert.equal((await calls()).at(-1).pid, warmWorker);
  assert.deepEqual(requests[2].body.messages.slice(0, 3), requests[1].body.messages);

  const billed = await last(await request(input("two", "billing")));
  assert.equal(billed.event?.type, "error", billed.message ?? stderr);
  assert.match(billed.event.error.errorMessage, /Claude Code billing: this request was charged to Claude usage credits/);
  const billedWorker = (await calls()).at(-1).pid;
  assert.notEqual(billedWorker, warmWorker);
  assert.throws(() => process.kill(billedWorker, 0), { code: "ESRCH" });

  const bypass = await (await request(input("bypass", "stdout-only", [initial, toolTurn, result("skip the relay")]))).result();
  assert(bypass.some(({ event }) => event?.type === "text_end" && event.content === "stdout-only answer"),
    "the CLI reached the upstream stdout-only fallback");
  assert.equal(bypass.at(-1).type, "error");
  assert.match(bypass.at(-1).message, /exactly one upstream request through the guest relay/);
  const bypassWorker = (await calls()).at(-1).pid;
  assert.throws(() => process.kill(bypassWorker, 0), { code: "ESRCH" });

  const wait = input("one", "wait", [...linear, third, user("wait")]);
  const stalled = await request(wait);
  assert.equal((await stalled.next()).event?.type, "start");
  await waitFor(() => requests.at(-1)?.prompt === "wait", "Cancellation turn did not reach the fixture");
  stalled.child.stdin.write(`${JSON.stringify({ id: wait.id, type: "cancel" })}\n`);
  assert.match((await last(stalled)).message, /Guest request cancelled/);
  await waitFor(() => requests.at(-1).disconnected, "Cancellation did not close the in-flight relay request");
  assert.equal((await calls()).at(-1).pid, warmWorker);
  assert.throws(() => process.kill(warmWorker, 0), { code: "ESRCH" });
  assert.deepEqual(requests.map(({ prompt }) => prompt), ["use a tool", "tool result", "linear", "billing", "wait"]);
});

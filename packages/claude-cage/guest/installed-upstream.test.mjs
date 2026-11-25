import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createAssistantEventAssembler, readFrames, writeFrame } from "./protocol.mjs";
import { startFixtureUpstream, toolUse } from "./fixtures/upstream.mjs";

const installed = process.env.PI_CLAUDE_CAGE_TEST_INSTALL_DIR;
const home = process.env.PI_CLAUDE_CAGE_TEST_HOME;
const hostModel = {
  id: "claude-opus-5-5", provider: "host-cage", api: "host-cage-stream-json", name: "Opus",
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, input: ["text", "image"],
  baseUrl: "http://example.invalid/host", contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true,
};
const user = (content) => ({ role: "user", content, timestamp: 0 });
const usage = (message) => [message.usage.input, message.usage.output, message.usage.cacheRead,
  message.usage.cacheWrite, message.usage.totalTokens];

test("pinned upstream caps warm replay requests at four cache breakpoints", {
  skip: !installed || !home,
}, () => {
  const output = execFileSync(join(installed, "node"), [
    "--experimental-transform-types",
    new URL("./fixtures/cache-breakpoints.mjs", import.meta.url).pathname,
  ], {
    encoding: "utf8",
    env: { ...process.env, PI_CLAUDE_CAGE_TEST_INSTALL_DIR: installed },
  });
  assert.equal(output.trim(), "PASS 8 cache-breakpoint request shapes");
});

async function waitFor(check, what) {
  for (let attempts = 0; attempts < 500; attempts++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(what);
}

test("installed stdio service preserves pinned upstream replay, billing, relay, and cleanup semantics", {
  skip: !installed || !home, timeout: 30_000,
}, async (t) => {
  const { requests, port } = await startFixtureUpstream(t);
  const bin = join(home, ".local/bin");
  await mkdir(bin, { recursive: true });
  const fixture = await readFile(new URL("./fixtures/claude-cli.mjs", import.meta.url), "utf8");
  await writeFile(join(bin, "claude"), `#!/usr/bin/env node\n${fixture}`, { mode: 0o700 });
  const redirect = new URL("./fixtures/redirect-upstream.mjs", import.meta.url).pathname;
  const child = spawn(join(installed, "node"), [
    "--experimental-transform-types", "--import", redirect, join(installed, "service.mjs"), "--stdio",
  ], {
    cwd: "/tmp",
    env: {
      HOME: home, PATH: process.env.PATH, PI_CLAUDE_CAGE_FIXTURE_PORT: String(port),
      ANTHROPIC_API_KEY: "fixture-only", GITHUB_TOKEN: "fixture-only", PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => child.kill("SIGKILL"));
  const frames = readFrames(child.stdout)[Symbol.asyncIterator]();
  assert.deepEqual((await frames.next()).value, { type: "ready", version: 2 }, stderr);
  let id = 0;

  async function request(frame, onFrame) {
    const requestId = ++id;
    await writeFrame(child.stdin, { id: requestId, ...frame });
    const responses = [];
    for (;;) {
      const item = await frames.next();
      assert.equal(item.done, false, stderr);
      assert.equal(item.value.id, requestId);
      responses.push(item.value);
      await onFrame?.(item.value);
      if (["value", "error"].includes(item.value.type) ||
          (item.value.type === "event" && ["done", "error"].includes(item.value.event.type))) return responses;
    }
  }

  function terminalEvents(responses) {
    const assembler = createAssistantEventAssembler();
    return responses.filter(({ type }) => type === "event").map(({ event }) => assembler.accept(event));
  }

  assert.deepEqual((await request({ op: "status" })).at(-1).value,
    { available: true, loggedIn: true, subscription: true, plan: "max" });
  const catalog = (await request({ op: "models" })).at(-1).value;
  assert.equal(catalog[0].id, "claude-haiku-4-5-20251001", stderr);
  const model = { ...catalog[0], provider: hostModel.provider, api: hostModel.api };
  const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
  const system = {
    role: "system", content: "Use the echo tool.", timestamp: 0,
    toolsAdded: [{ name: "echo", description: "Echo a string", parameters: schema }],
  };

  async function turn(transcript, onFrame) {
    const responses = await request({
      op: "turn", model, transcript, options: {
        env: { PI_CLAUDE_CODE_COMMAND: "/not/allowed", UNTRUSTED: "ignore" }, timeoutMs: 20_000,
      },
    }, onFrame);
    return { responses, events: terminalEvents(responses), accepted: responses.find(({ type }) => type === "accepted") };
  }

  function assertRelayed(result, reason, requestIndex) {
    const terminal = result.events.at(-1);
    assert.equal(terminal.type, "done", terminal.error?.errorMessage ?? result.responses.at(-1).message ?? stderr);
    assert.equal(terminal.reason, reason);
    const { message } = terminal;
    assert.deepEqual([message.model, message.provider, message.api], [model.id, hostModel.provider, hostModel.api]);
    const diagnostics = message.diagnostics.filter(({ type }) => type === "claude-code.turn-relay");
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0].details, {
      upstreamRequests: 1, blockedRequests: 0, requestId: requests[requestIndex].id,
    });
    assert.equal(message.responseId, `msg_${requests[requestIndex].id}`);
    return message;
  }

  const initial = user("use a tool");
  const first = await turn({ mode: "full", messages: [system, initial] });
  assert.deepEqual(first.events.map(({ type }) => type), ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
  const toolCall = { type: "toolCall", id: toolUse.id, name: "echo", arguments: toolUse.input };
  assert.deepEqual(first.events[3].toolCall, toolCall);
  const toolTurn = assertRelayed(first, "toolUse", 0);
  assert.deepEqual(toolTurn.content, [toolCall]);
  assert.deepEqual(requests[0].body.messages, [{ role: "user", content: [{ type: "text", text: initial.content }] }]);
  assert.equal(requests[0].body.system, system.content);
  assert.deepEqual(requests[0].body.tools, [{ name: toolUse.name, description: "Echo a string", input_schema: schema }]);

  const toolResult = {
    role: "toolResult", toolCallId: toolUse.id, toolName: "echo", timestamp: 1, isError: false,
    content: [{ type: "text", text: "real Pi tool output" }],
  };
  const second = await turn({
    mode: "append", baseHash: first.accepted.transcriptHash, messages: [toolTurn, toolResult],
  });
  const answer = assertRelayed(second, "stop", 1);
  assert.deepEqual(answer.content, [{ type: "text", text: "loopback answer: tool result" }]);
  assert.deepEqual(usage(answer), [7, 3, 11, 2, 23]);
  assert(answer.usage.cost.total > 0);
  assert.deepEqual(requests[1].body.messages, [
    requests[0].body.messages[0], { role: "assistant", content: [toolUse] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "real Pi tool output", is_error: false }] },
  ]);

  const third = await turn({
    mode: "append", baseHash: second.accepted.transcriptHash, messages: [answer, user("linear")],
  });
  const linear = assertRelayed(third, "stop", 2);
  assert.equal(linear.content[0].text, "loopback answer: linear");

  const billed = await turn({
    mode: "append", baseHash: third.accepted.transcriptHash, messages: [linear, user("billing")],
  });
  assert.equal(billed.events.at(-1).type, "error");
  assert.match(billed.events.at(-1).error.errorMessage, /charged to Claude usage credits/);

  const bypass = await turn({ mode: "full", messages: [system, initial, toolTurn, { ...toolResult, content: [{ type: "text", text: "skip the relay" }] }] });
  assert(bypass.events.some(({ type, content }) => type === "text_end" && content === "stdout-only answer"));
  assert.equal(bypass.responses.at(-1).type, "error");
  assert.match(bypass.responses.at(-1).message, /exactly one upstream request through the guest relay/);

  let cancellationId;
  const cancellation = (async () => {
    const requestId = id + 1;
    cancellationId = requestId;
    return turn({ mode: "full", messages: [system, user("wait")] }, async (frame) => {
      if (frame.type === "event" && frame.event.type === "start") {
        await waitFor(() => requests.at(-1)?.prompt === "wait", "Cancellation turn did not reach the loopback model");
        await writeFrame(child.stdin, { type: "cancel", id: requestId });
      }
    });
  })();
  const cancelled = await cancellation;
  assert.equal(cancelled.responses.at(-1).type, "error");
  assert.match(cancelled.responses.at(-1).message, /cancelled/);
  assert(Number.isSafeInteger(cancellationId));
  await waitFor(() => requests.at(-1)?.disconnected, "Cancellation did not close the in-flight relay request");

  const calls = readFile(join(home, "calls.jsonl"), "utf8").then((text) => text.trim().split("\n").map(JSON.parse));
  assert((await calls).length >= 6, "the fake CLI must observe replay, continuation, error, and cancellation frames");
  child.stdin.end();
  assert.deepEqual(await exited, [0, null], stderr);
  assert.deepEqual(requests.map(({ prompt }) => prompt), ["use a tool", "tool result", "linear", "billing", "wait"]);
});

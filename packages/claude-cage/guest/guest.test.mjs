import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createGuestService } from "./service.mjs";
import { createAssistantEventAssembler, readFrames, writeFrame } from "./protocol.mjs";

const usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model = {
  id: "fixture", provider: "claude-cage", api: "claude-cage", baseUrl: "process://claude-cage",
  name: "Fixture", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 10_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const user = (content) => ({ role: "user", content, timestamp: 1 });

function doneMessage(model, content, reason = "stop") {
  return {
    role: "assistant", provider: model.provider, api: model.api, model: model.id,
    content, stopReason: reason, timestamp: Date.now(), usage,
    diagnostics: [{ type: "claude-code.turn-relay", details: { upstreamRequests: 1 } }],
  };
}

function fixtureUpstream() {
  const calls = [];
  const closes = [];
  return {
    calls, closes,
    async getClaudeStatus() { return { available: true, loggedIn: true, subscription: true, plan: "max" }; },
    async discoverClaudeModels() { return [{ ...model, provider: "upstream", api: "upstream" }]; },
    modelFromDiscovery(entry) { return entry; },
    async *streamClaudeCode(requestModel, context, options) {
      calls.push({ model: requestModel, context, options });
      const output = doneMessage(requestModel, [], "pending");
      output.stopReason = "pending";
      yield { type: "start", partial: output };
      const last = context.messages.at(-1);
      if (last.content === "wait") {
        await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
        options.signal.throwIfAborted();
      }
      const text = `reply:${typeof last.content === "string" ? last.content : "image"}`;
      const block = { type: "text", text: "" };
      output.content.push(block);
      yield { type: "text_start", contentIndex: 0, partial: output };
      block.text = text;
      yield { type: "text_delta", contentIndex: 0, delta: text, partial: output };
      yield { type: "text_end", contentIndex: 0, content: text, partial: output };
      const message = doneMessage(requestModel, [{ type: "text", text }]);
      yield { type: "done", reason: "stop", message };
    },
    async closeClaudeProcesses(sessionId) { closes.push(sessionId ?? "all"); },
  };
}

async function start(upstream, options) {
  const input = new PassThrough();
  const output = new PassThrough();
  const service = createGuestService(upstream, options);
  const running = service.run(input, output);
  const frames = readFrames(output)[Symbol.asyncIterator]();
  assert.deepEqual((await frames.next()).value, { type: "ready", version: 2 });
  return { input, output, service, frames, running };
}

async function request(io, frame) {
  await writeFrame(io.input, frame);
  const responses = [];
  for (;;) {
    const { value, done } = await io.frames.next();
    assert.equal(done, false);
    responses.push(value);
    if (value.id === frame.id && (value.type === "value" || value.type === "error" ||
      (value.type === "event" && ["done", "error"].includes(value.event?.type)))) return responses;
  }
}

function assembled(responses) {
  const assembler = createAssistantEventAssembler();
  return responses.filter(({ type }) => type === "event").map(({ event }) => assembler.accept(event));
}

test("one stdio service handles metadata, full transcript, and append transcript", async () => {
  const upstream = fixtureUpstream();
  const io = await start(upstream, { sessionId: "session" });
  assert.deepEqual((await request(io, { id: 1, op: "status" })).at(-1).value,
    { available: true, loggedIn: true, subscription: true, plan: "max" });
  assert.equal((await request(io, { id: 2, op: "models" })).at(-1).value[0].id, "fixture");

  const image = { type: "image", mimeType: "image/png", data: "A".repeat(1024) };
  const firstMessages = [user([{ type: "text", text: "first" }, image])];
  const first = await request(io, {
    id: 3, op: "turn", model, transcript: { mode: "full", messages: firstMessages }, options: {},
  });
  const accepted = first.find(({ type }) => type === "accepted");
  assert.equal(typeof accepted.transcriptHash, "string");
  assert.equal(assembled(first).at(-1).message.content[0].text, "reply:image");

  const suffix = [doneMessage(model, [{ type: "text", text: "reply:image" }]), user("second")];
  const second = await request(io, {
    id: 4, op: "turn", model,
    transcript: { mode: "append", baseHash: accepted.transcriptHash, messages: suffix }, options: {},
  });
  assert.equal(assembled(second).at(-1).message.content[0].text, "reply:second");
  assert.deepEqual(upstream.calls[1].context.messages, [...firstMessages, ...suffix]);
  assert.equal(upstream.calls[0].options.sessionId, "session");
  assert.equal(upstream.calls[1].options.sessionId, "session");
  await writeFrame(io.input, { type: "cancel", id: 4 });
  assert.equal((await request(io, { id: 5, op: "status" })).at(-1).value.available, true);

  io.input.end();
  await io.running;
  assert(upstream.closes.includes("all"));
});

test("clean cancellation invalidates transcript and keeps the stdio service usable", async () => {
  const upstream = fixtureUpstream();
  const io = await start(upstream, { sessionId: "session" });
  await writeFrame(io.input, {
    id: 1, op: "turn", model, transcript: { mode: "full", messages: [user("wait")] }, options: {},
  });
  assert.equal((await io.frames.next()).value.type, "accepted");
  assert.equal((await io.frames.next()).value.event.type, "start");
  await writeFrame(io.input, { type: "cancel", id: 1 });
  const cancelled = await io.frames.next();
  assert.equal(cancelled.value.type, "error");
  assert.match(cancelled.value.message, /cancelled/);
  assert.equal(cancelled.value.fatal, false);
  assert.equal(io.service.transcriptHash, undefined);

  const next = await request(io, {
    id: 2, op: "turn", model, transcript: { mode: "full", messages: [user("next")] }, options: {},
  });
  assert.equal(assembled(next).at(-1).reason, "stop");
  io.input.end();
  await io.running;
});

test("append hash mismatch is fatal before invoking upstream", async () => {
  const upstream = fixtureUpstream();
  const io = await start(upstream, { sessionId: "session" });
  const result = await request(io, {
    id: 1, op: "turn", model,
    transcript: { mode: "append", baseHash: "wrong", messages: [user("never")] }, options: {},
  });
  assert.equal(result.at(-1).fatal, true);
  assert.match(result.at(-1).message, /hashes differ/);
  assert.equal(upstream.calls.length, 0);
  await assert.rejects(io.running);
});

test("turn timeout closes its worker and returns a nonfatal operation error", async () => {
  const upstream = fixtureUpstream();
  const io = await start(upstream, { sessionId: "session", turnTimeoutMs: 50 });
  const result = await request(io, {
    id: 1, op: "turn", model,
    transcript: { mode: "full", messages: [user("wait")] }, options: {},
  });
  assert.equal(result.at(-1).fatal, false);
  assert.match(result.at(-1).message, /timed out/);
  assert(upstream.closes.includes("session"));
  io.input.end();
  await io.running;
});

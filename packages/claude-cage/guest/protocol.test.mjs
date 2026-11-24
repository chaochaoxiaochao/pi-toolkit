import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  PROTOCOL_VERSION, readFrames, writeFrame, compactAssistantEvent, createAssistantEventAssembler,
} from "./protocol.mjs";

const usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const message = () => ({
  role: "assistant", provider: "claude-cage", api: "claude-cage", model: "fixture",
  content: [], stopReason: "pending", timestamp: 1, usage,
});

async function collect(stream, options) {
  const frames = [];
  for await (const frame of readFrames(stream, options)) frames.push(frame);
  return frames;
}

test("protocol v2 reads fragmented UTF-8 NDJSON and rejects an oversized logical frame", async () => {
  assert.equal(PROTOCOL_VERSION, 2);
  const stream = new PassThrough();
  const result = collect(stream, { maxBytes: 80 });
  const body = Buffer.from(`${JSON.stringify({ id: 1, text: "甲乙" })}\n`);
  for (const byte of body) stream.write(Buffer.from([byte]));
  stream.end();
  assert.deepEqual(await result, [{ id: 1, text: "甲乙" }]);

  const tooLarge = new PassThrough();
  const failed = collect(tooLarge, { maxBytes: 8 });
  tooLarge.end(`${JSON.stringify({ value: "too large" })}\n`);
  await assert.rejects(failed, /frame exceeds 8 bytes/);

  const truncated = new PassThrough();
  const incomplete = collect(truncated);
  truncated.end('{"id":1');
  await assert.rejects(incomplete, /partial frame/);
});

test("writeFrame slices a large frame and waits for backpressure", async () => {
  const chunks = [];
  let drains = 0;
  const sink = new Writable({
    highWaterMark: 8,
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      setImmediate(() => { drains++; done(); });
    },
  });
  await writeFrame(sink, { id: 3, value: "甲".repeat(30) }, { maxBytes: 512, chunkBytes: 7 });
  sink.end();
  assert(drains > 1, "the fixture must exercise more than one bounded write");
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), { id: 3, value: "甲".repeat(30) });
});

test("compact assistant events have linear wire growth and reconstruct one shared partial", () => {
  const source = message();
  const start = compactAssistantEvent({ type: "start", partial: source });
  const assembler = createAssistantEventAssembler();
  const first = assembler.accept(start);
  const shared = first.partial;
  const block = { type: "thinking", thinking: "", thinkingSignature: "", redacted: false };
  source.content.push(block);
  assembler.accept(compactAssistantEvent({ type: "thinking_start", contentIndex: 0, partial: source }));

  let wireBytes = JSON.stringify(start).length;
  for (let index = 0; index < 4_000; index++) {
    block.thinking += "甲";
    const wire = compactAssistantEvent({ type: "thinking_delta", contentIndex: 0, delta: "甲", partial: source });
    wireBytes += JSON.stringify(wire).length;
    const event = assembler.accept(wire);
    assert.equal(event.partial, shared);
  }
  block.thinkingSignature = "signed";
  const ended = assembler.accept(compactAssistantEvent({
    type: "thinking_end", contentIndex: 0, content: block.thinking, partial: source,
  }));
  assert.equal(ended.partial, shared);
  assert.equal(ended.partial.content[0].thinking.length, 4_000);
  assert.equal(ended.partial.content[0].thinkingSignature, "signed");
  assert(wireBytes < 500_000, `wire should be linear, got ${wireBytes} bytes`);
});

test("assembler preserves fragmented tool arguments and validates terminal content", () => {
  const source = message();
  const assembler = createAssistantEventAssembler();
  assembler.accept(compactAssistantEvent({ type: "start", partial: source }));
  const tool = { type: "toolCall", id: "tool-1", name: "echo", arguments: {}, partialJson: "" };
  source.content.push(tool);
  assembler.accept(compactAssistantEvent({ type: "toolcall_start", contentIndex: 0, partial: source }));
  for (const delta of ['{"text":', '"hello"}']) {
    tool.partialJson += delta;
    tool.arguments = { text: delta.endsWith("}") ? "hello" : undefined };
    assembler.accept(compactAssistantEvent({ type: "toolcall_delta", contentIndex: 0, delta, partial: source }));
  }
  delete tool.partialJson;
  tool.arguments = { text: "hello" };
  assembler.accept(compactAssistantEvent({ type: "toolcall_end", contentIndex: 0, toolCall: tool, partial: source }));
  const doneMessage = { ...source, content: [tool], stopReason: "toolUse" };
  const done = assembler.accept(compactAssistantEvent({ type: "done", reason: "toolUse", message: doneMessage }));
  assert.deepEqual(done.message.content, [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { text: "hello" } }]);
});

test("compact events preserve redacted thinking blocks without exposing deltas", () => {
  const source = message();
  const assembler = createAssistantEventAssembler();
  assembler.accept(compactAssistantEvent({ type: "start", partial: source }));
  const redacted = { type: "thinking", thinking: "", thinkingSignature: "", redacted: true, data: "opaque" };
  source.content.push(redacted);
  const start = compactAssistantEvent({ type: "thinking_start", contentIndex: 0, partial: source });
  assert.deepEqual(start.block, redacted);
  assembler.accept(start);
  assembler.accept(compactAssistantEvent({ type: "thinking_end", contentIndex: 0, partial: source }));
  const final = { ...source, stopReason: "stop" };
  assert.deepEqual(assembler.accept(compactAssistantEvent({ type: "done", reason: "stop", message: final })).message.content,
    [redacted]);
});

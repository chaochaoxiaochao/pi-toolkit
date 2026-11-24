import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createGuestService } from "./service.mjs";

const report = (type, fields = {}) => process.stderr.write(`WIRED_SMOKE ${JSON.stringify({ type, ...fields })}\n`);
const usage = {
  input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let retained = false;
let turns = 0;
let descendant;
const message = (model, content, reason = "stop") => ({
  role: "assistant", api: model.api, provider: model.provider, model: model.id,
  content, usage, timestamp: Date.now(), stopReason: reason,
  diagnostics: [{ type: "claude-code.turn-relay", details: { upstreamRequests: 1 } }],
});

const service = createGuestService({
  async getClaudeStatus() { return { available: true, loggedIn: true, subscription: true, plan: "mock" }; },
  async discoverClaudeModels() { return []; },
  modelFromDiscovery(entry) { return entry; },
  async *streamClaudeCode(model, { messages }, { sessionId, signal }) {
    turns++;
    retained = true;
    if (!descendant) {
      descendant = spawn("sh", ["-c", "sleep 60"], { stdio: "ignore" });
      report("descendant", { pid: descendant.pid });
    }
    const last = messages.at(-1);
    const prompt = typeof last.content === "string" ? last.content : last.content?.[0]?.text;
    const image = Array.isArray(last.content) ? last.content.find(({ type }) => type === "image") : undefined;
    report("turn", {
      turns, sessionId, prompt, messages: messages.length,
      imageBytes: image?.data.length, imageHash: image && createHash("sha256").update(image.data).digest("hex"),
    });
    const output = { ...message(model, [], "pending"), stopReason: "pending", diagnostics: undefined };
    yield { type: "start", partial: output };
    if (prompt === "wait") {
      if (!signal.aborted) await once(signal, "abort");
      report("aborted", { sessionId, reason: String(signal.reason?.message ?? signal.reason) });
      signal.throwIfAborted();
    }
    if (prompt === "tool") {
      const tool = { type: "toolCall", id: randomUUID(), name: "echo", arguments: { phrase: "wired" } };
      output.content.push(tool);
      yield { type: "toolcall_start", contentIndex: 0, partial: output };
      yield { type: "toolcall_end", contentIndex: 0, partial: output, toolCall: tool };
      yield { type: "done", reason: "toolUse", message: message(model, [tool], "toolUse") };
      return;
    }
    if (prompt === "thinking") {
      const block = { type: "thinking", thinking: "", thinkingSignature: "sig" };
      output.content.push(block);
      yield { type: "thinking_start", contentIndex: 0, partial: output };
      for (let index = 0; index < 5_000; index++) {
        const delta = `思${index % 10}`;
        block.thinking += delta;
        yield { type: "thinking_delta", contentIndex: 0, delta, partial: output };
      }
      yield { type: "thinking_end", contentIndex: 0, content: block.thinking, contentSignature: "sig", partial: output };
      yield { type: "done", reason: "stop", message: message(model, [block]) };
      return;
    }
    const text = prompt === "large" ? "大".repeat(12 * 1024 * 1024) : `received:${prompt}`;
    const block = { type: "text", text: "" };
    output.content.push(block);
    yield { type: "text_start", contentIndex: 0, partial: output };
    block.text = text;
    yield { type: "text_delta", contentIndex: 0, delta: text, partial: output };
    yield { type: "text_end", contentIndex: 0, content: text, partial: output };
    yield { type: "done", reason: "stop", message: message(model, [{ type: "text", text }]) };
  },
  async closeClaudeProcesses(sessionId) {
    const released = retained;
    retained = false;
    if (descendant) {
      const child = descendant;
      descendant = undefined;
      child.kill("SIGTERM");
      if (child.exitCode === null) await once(child, "close");
      report("descendantClosed", { pid: child.pid });
    }
    report("closed", { sessionId: sessionId ?? "all", released });
  },
});

report("readyFixture");
await service.run(process.stdin, process.stdout);
assert.equal(retained, false);
report("stopped", { turns, retained });

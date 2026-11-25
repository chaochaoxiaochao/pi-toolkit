import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { createGuestService } from "../guest/service.mjs";
import { PROTOCOL_VERSION, readFrames, writeFrame } from "../guest/protocol.mjs";

const { CLAUDE_CAGE_CONFIG } = process.env;
const profile = JSON.parse(readFileSync(CLAUDE_CAGE_CONFIG, "utf8"));
assert(!process.env.ANTHROPIC_API_KEY && !process.env.TEST_HOST_SECRET);
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 4), ["run", "--workdir", "/tmp", "--"]);
const log = (operation) => appendFileSync(profile.log, `${JSON.stringify({ config: CLAUDE_CAGE_CONFIG, ...operation })}\n`);

process.stdout.write("Cage entered the configured VM\n");
if (args[4] === "bash") {
  assert.equal(args[5], "-c");
  execFileSync("bash", ["-n", "-c", args[6]]);
  if (args[6].includes("PI_CAGE_CHECK=")) {
    assert.match(args[6], /claude --version/);
    log({ phase: "preflight" });
    for (const key of ["node", "claude"]) if (profile.mode !== key) process.stdout.write(`PI_CAGE_CHECK=${key}\n`);
    process.stdout.write(`PI_CAGE_SERVICE=${profile.servicePath}\n`);
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const files = execFileSync("tar", ["-tzf", "-"], { input: Buffer.concat(chunks), encoding: "utf8" }).trim().split("\n");
    log({ phase: "install", files });
    process.stdout.write(`Installed guest service: ${profile.servicePath}\n`);
  }
} else {
  const command = args.slice(4);
  assert.equal(command[0], "env");
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT"]) {
    const index = command.indexOf(name);
    assert(index > 0 && command[index - 1] === "-u", `${name} must be removed before Node starts`);
  }
  assert.equal(command.at(-2), profile.servicePath);
  assert.equal(command.at(-1), "--stdio");
  log({ phase: "proxy", command });
  if (profile.mode === "hang-ready") {
    for await (const _ of process.stdin) assert.fail("Host wrote before ready");
  } else if (profile.mode === "preamble-limit") {
    for (let line = 0; line < 130; line++) {
      if (!process.stdout.write(`${"x".repeat(1023)}\n`)) {
        await new Promise((resolve) => process.stdout.once("drain", resolve));
      }
    }
    process.exit(0);
  } else if (profile.mode === "disconnect") {
    process.stdout.write(`${JSON.stringify({ type: "ready", version: PROTOCOL_VERSION })}\n`);
    const iterator = readFrames(process.stdin)[Symbol.asyncIterator]();
    await iterator.next();
    process.stderr.write("connection disappeared\n");
    process.exit(1);
  } else if (profile.mode === "wrong-id") {
    process.stdout.write(`${JSON.stringify({ type: "ready", version: PROTOCOL_VERSION })}\n`);
    const iterator = readFrames(process.stdin)[Symbol.asyncIterator]();
    await iterator.next();
    await writeFrame(process.stdout, { id: 999, type: "value", value: null });
    process.exit(0);
  } else if (profile.mode === "turn-error") {
    process.stdout.write(`${JSON.stringify({ type: "ready", version: PROTOCOL_VERSION })}\n`);
    const iterator = readFrames(process.stdin)[Symbol.asyncIterator]();
    const request = (await iterator.next()).value;
    await writeFrame(process.stdout, { id: request.id, type: "error", fatal: false, message: "connection closed: 503" });
    for await (const _ of process.stdin) {}
  } else {
    let attempt = 0;
    const usage = {
      input: 15, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 24,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const done = (model, content, reason, messageUsage = usage) => ({
      role: "assistant", model: model.id, provider: model.provider, api: model.api,
      content, stopReason: reason, timestamp: Date.now(), usage: messageUsage,
      diagnostics: [{ type: "claude-code.turn-relay", details: { upstreamRequests: 1 } }],
    });
    const service = createGuestService({
      async getClaudeStatus() {
        log({ phase: "status" });
        if (profile.mode === "slow-status") await new Promise((resolve) => setTimeout(resolve, 100));
        return { available: true, loggedIn: true, subscription: true, plan: "max" };
      },
      async discoverClaudeModels() {
        log({ phase: "models" });
        return [{
          id: "claude-mock", provider: "upstream", api: "upstream-api", baseUrl: "process://upstream",
          name: "Mock Claude", input: ["text", "image"], reasoning: true,
          contextWindow: 200_000, maxTokens: 16_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          promptCache: { short: 300, long: 3600 },
          supportsAdaptiveThinking: true,
          headers: { Authorization: "hidden" },
        }];
      },
      modelFromDiscovery(entry) {
        const { supportsAdaptiveThinking: _supportsAdaptiveThinking, ...mapped } = entry;
        return mapped;
      },
      async *streamClaudeCode(model, context, options) {
        attempt++;
        log({ phase: "turn", attempt, context, sessionId: options.sessionId, options: {
          reasoning: options.reasoning, cacheRetention: options.cacheRetention,
          maxTokens: options.maxTokens, timeoutMs: options.timeoutMs,
        } });
        const messageUsage = options.maxTokens === 1 ? {
          input: 1, output: 1, cacheRead: 128, cacheWrite: 0, totalTokens: 130,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        } : usage;
        const output = { ...done(model, [], "pending", messageUsage), stopReason: "pending", diagnostics: undefined };
        yield { type: "start", partial: output };
        if (context.messages.at(-1).content === "hold") {
          await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
          options.signal.throwIfAborted();
        }
        if (context.messages.at(-1).content === "raw guest failure") {
          yield { type: "error", reason: "error", error: { ...output, stopReason: "error", errorMessage: "rate limit; 503; prompt is too long" } };
          return;
        }
        const requestsTool = Array.isArray(context.messages.at(-1).content) &&
          context.messages.at(-1).content.some(({ type }) => type === "image");
        if (requestsTool) {
          const tool = { type: "toolCall", id: "tool-1", name: "echo", arguments: { phrase: "甲" } };
          output.content.push(tool);
          yield { type: "toolcall_start", contentIndex: 0, partial: output };
          yield { type: "toolcall_end", contentIndex: 0, partial: output, toolCall: tool };
          yield { type: "done", reason: "toolUse", message: done(model, [tool], "toolUse", messageUsage) };
        } else {
          const text = `收到：${context.messages.at(-1).content[0].text}`;
          const block = { type: "text", text: "" };
          output.content.push(block);
          yield { type: "text_start", contentIndex: 0, partial: output };
          block.text = text;
          yield { type: "text_delta", contentIndex: 0, delta: text, partial: output };
          yield { type: "text_end", contentIndex: 0, content: text, partial: output };
          yield { type: "done", reason: "stop", message: done(model, [{ type: "text", text }], "stop", messageUsage) };
        }
      },
      async closeClaudeProcesses(sessionId) { log({ phase: "closed", sessionId: sessionId ?? "all" }); },
    });
    const serviceInput = new PassThrough();
    const relay = (async () => {
      try {
        for await (const frame of readFrames(process.stdin)) {
          log({
            phase: "wire", op: frame.op ?? frame.type, mode: frame.transcript?.mode,
            transcriptBytes: frame.transcript ? Buffer.byteLength(JSON.stringify(frame.transcript)) : 0,
            containsImage: JSON.stringify(frame.transcript ?? {}).includes("\"mimeType\":\"image/png\""),
          });
          await writeFrame(serviceInput, frame);
        }
      } finally {
        serviceInput.end();
      }
    })();
    await Promise.all([service.run(serviceInput, process.stdout), relay]);
  }
}

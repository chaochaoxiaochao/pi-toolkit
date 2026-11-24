// Explicit opt-in. Uses a real already-running Cage Wired VM and a mock model only.
// No Claude login, discovery, or Anthropic request is made.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAssistantEventAssembler, readFrames, writeFrame } from "../guest/protocol.mjs";

const executable = process.env.CAGE_TEST_EXECUTABLE || join(process.env.HOME, ".local/opt/claude-cage-wired/0.2.0-wired.1/cage");
const prefix = "WIRED_SMOKE ";
const startGuest = `
set -eu
umask 077
scratch=$(mktemp -d /tmp/pi-cage-wired-smoke.XXXXXXXXXX)
cleanup() {
  status=$?
  rm -rf -- "$scratch"
  printf 'WIRED_SMOKE {"type":"removed","root":"%s"}\n' "$scratch" >&2
  exit "$status"
}
trap cleanup EXIT HUP INT TERM
timeout 10s head -c "$1" > "$scratch/fixture.tar.gz"
tar -xzf "$scratch/fixture.tar.gz" -C "$scratch"
cd "$scratch"
env -i HOME="$scratch" TMPDIR="$scratch" PATH=/usr/bin:/bin \
  timeout --kill-after=3s 90s node --experimental-transform-types wired-smoke.fixture.mjs --stdio
`;

function cageOptions(config) {
  const env = { CLAUDE_CAGE_CONFIG: config };
  for (const name of ["HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { env, cwd: "/tmp" };
}

async function protocolFrames(stream) {
  const iterator = stream[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  for (;;) {
    const item = await iterator.next();
    if (item.done) throw new Error("Cage exited before the fixture ready frame");
    pending = pending.length ? Buffer.concat([pending, item.value]) : item.value;
    for (;;) {
      const newline = pending.indexOf(10);
      if (newline < 0) break;
      const line = pending.subarray(0, newline).toString("utf8");
      pending = pending.subarray(newline + 1);
      if (line !== '{"type":"ready","version":2}') continue;
      return readFrames({
        async *[Symbol.asyncIterator]() {
          if (pending.length) yield pending;
          for (;;) {
            const next = await iterator.next();
            if (next.done) return;
            yield next.value;
          }
        },
      })[Symbol.asyncIterator]();
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log("SKIP Cage Wired smoke (explicit opt-in: node packages/claude-cage/tests/wired-smoke.mjs --run)");
    return;
  }
  assert.deepEqual(args, ["--run"]);
  const config = process.env.CAGE_TEST_CONFIG || join(process.env.HOME, ".claude-cage-wired/config.json");
  assert(statSync(config).isFile());
  accessSync(config, constants.R_OK);
  accessSync(executable, constants.X_OK);
  const options = cageOptions(config);
  const listed = execFileSync(executable, ["list"], { ...options, encoding: "utf8", timeout: 10_000 });
  assert.equal(listed.split("\n").filter((line) => /^\s*(?!base\s)\S+\s+Running\s+/.test(line)).length, 1,
    "Expected one already-running non-base VM; this test never starts a VM");

  const archive = execFileSync("/usr/bin/tar", ["-czf", "-",
    "-C", fileURLToPath(new URL("../guest/", import.meta.url)), "service.mjs", "protocol.mjs",
    "-C", fileURLToPath(new URL("./", import.meta.url)), "wired-smoke.fixture.mjs",
  ], { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 });
  const child = spawn(executable, ["run", "--workdir", "/tmp", "--", "bash", "-c", startGuest, "wired-smoke", String(archive.length)], {
    ...options, stdio: ["pipe", "pipe", "pipe"],
  });
  const reports = [];
  let stderr = "";
  let stderrBuffer = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    stderrBuffer += chunk;
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop();
    for (const line of lines) if (line.startsWith(prefix)) reports.push(JSON.parse(line.slice(prefix.length)));
  });
  child.stdin.write(archive);
  const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const frames = await protocolFrames(child.stdout);
  let id = 0;
  let baseHash;

  async function turn(transcript, onFrame) {
    const requestId = ++id;
    const model = {
      id: "wired-smoke-local", name: "Local mock", provider: "claude-cage", api: "claude-cage",
      baseUrl: "process://wired", reasoning: true, input: ["text", "image"], contextWindow: 200_000_000, maxTokens: 50_000_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    await writeFrame(child.stdin, { id: requestId, op: "turn", model, transcript, options: { timeoutMs: 60_000 } });
    const responses = [];
    for (;;) {
      const item = await frames.next();
      assert.equal(item.done, false, stderr);
      assert.equal(item.value.id, requestId);
      responses.push(item.value);
      await onFrame?.(item.value);
      if (item.value.type === "accepted") baseHash = item.value.transcriptHash;
      if (["value", "error"].includes(item.value.type) ||
          (item.value.type === "event" && ["done", "error"].includes(item.value.event.type))) break;
    }
    const assembler = createAssistantEventAssembler();
    const events = responses.filter(({ type }) => type === "event").map(({ event }) => assembler.accept(event));
    return { responses, events };
  }

  const user = (content) => ({ role: "user", content, timestamp: 1 });
  const tool = await turn({ mode: "full", messages: [user("tool")] });
  assert.deepEqual(tool.events.map(({ type }) => type), ["start", "toolcall_start", "toolcall_end", "done"]);
  const toolMessage = tool.events.at(-1).message;
  assert.match(toolMessage.content[0].id, /^[a-f0-9-]{36}$/);
  assert.equal(toolMessage.content[0].name, "echo");

  const toolResult = {
    role: "toolResult", toolName: "echo", toolCallId: toolMessage.content[0].id, isError: false,
    content: [{ type: "text", text: "result" }], timestamp: 2,
  };
  const continued = await turn({ mode: "append", baseHash, messages: [toolMessage, toolResult] });
  assert.equal(continued.events.at(-1).message.content[0].text, "received:result");

  let compactBytes = 0;
  const thinking = await turn({ mode: "append", baseHash, messages: [continued.events.at(-1).message, user("thinking")] },
    (frame) => { compactBytes += Buffer.byteLength(JSON.stringify(frame)); });
  assert.equal(thinking.events.filter(({ type }) => type === "thinking_delta").length, 5_000);
  assert.equal(thinking.events.at(-1).message.content[0].thinking.length, 10_000);
  assert(compactBytes < 2_000_000, `thinking wire should grow linearly, got ${compactBytes} bytes`);

  const image = { type: "image", mimeType: "image/png", data: "A".repeat(34 * 1024 * 1024) };
  const large = await turn({ mode: "full", messages: [user([{ type: "text", text: "large" }, image])] });
  assert.equal(large.events.at(-1).message.content[0].text.length, 12 * 1024 * 1024);
  assert(Buffer.byteLength(large.events.at(-1).message.content[0].text) > 32 * 1024 * 1024);
  const largeReport = reports.find(({ type, prompt }) => type === "turn" && prompt === "large");
  assert.equal(largeReport.imageBytes, image.data.length);
  assert.equal(largeReport.imageHash, createHash("sha256").update(image.data).digest("hex"));

  // Simulate abrupt host loss during an active turn. EOF must abort and clean the guest worker.
  const requestId = ++id;
  const model = {
    id: "wired-smoke-local", name: "Local mock", provider: "claude-cage", api: "claude-cage",
    baseUrl: "process://wired", reasoning: true, input: ["text"], contextWindow: 1024, maxTokens: 128,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  await writeFrame(child.stdin, { id: requestId, op: "turn", model,
    transcript: { mode: "full", messages: [user("wait")] }, options: { timeoutMs: 60_000 } });
  assert.equal((await frames.next()).value.type, "accepted");
  assert.equal((await frames.next()).value.event.type, "start");
  child.stdin.end();
  const terminal = await frames.next();
  assert.equal(terminal.value.type, "error");
  assert.match(terminal.value.message, /closed the Cage service input/);
  assert.deepEqual(await exited, { code: 0, signal: null }, stderr);

  for (let attempts = 0; attempts < 100 && !reports.some(({ type }) => type === "removed"); attempts++) await delay(10);
  assert(reports.some(({ type }) => type === "aborted"));
  const descendant = reports.find(({ type }) => type === "descendant");
  assert(descendant && reports.some(({ type, pid }) => type === "descendantClosed" && pid === descendant.pid));
  assert(reports.some(({ type, retained }) => type === "stopped" && retained === false));
  assert(reports.some(({ type }) => type === "removed"));
  assert.equal(reports.filter(({ type }) => type === "turn").length, 5);
  console.log("PASS Cage Wired stdio smoke: persistent transcript sync, 5,000 thinking deltas, >32 MiB frames, EOF cleanup");
}

try { await main(); } catch (error) { console.error(error); process.exitCode = 1; }

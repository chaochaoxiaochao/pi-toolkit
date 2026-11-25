import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_FRAME_BYTES, PROTOCOL_VERSION, TURN_TIMEOUT_MS,
  compactAssistantEvent, isId, isRecord, readFrames, writeFrame,
} from "./protocol.mjs";

const METADATA_TIMEOUT_MS = 25_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const READY = JSON.stringify({ type: "ready", version: PROTOCOL_VERSION });

function transcriptHash(messages) {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function transcriptBytes(messages) {
  return Buffer.byteLength(JSON.stringify(messages));
}

function checkedTranscript(spec, committed, maxBytes) {
  if (!isRecord(spec) || !Array.isArray(spec.messages) || !["full", "append"].includes(spec.mode)) {
    throw new Error("Turn requires a full or append transcript");
  }
  let messages;
  if (spec.mode === "full") {
    messages = spec.messages;
  } else {
    if (!committed || typeof spec.baseHash !== "string" || spec.baseHash !== committed.hash) {
      const error = new Error("Host and guest transcript hashes differ");
      error.fatal = true;
      throw error;
    }
    messages = [...committed.messages, ...spec.messages];
  }
  if (transcriptBytes(messages) > maxBytes) throw new Error(`Reconstructed transcript exceeds ${maxBytes} bytes`);
  return { messages, hash: transcriptHash(messages) };
}

function turnParameters(request, signal, sessionId, timeoutMs, messages) {
  const { model, options = {} } = request;
  if (!isRecord(model) || ![model.id, model.provider, model.api].every(
    (name) => typeof name === "string" && name.length > 0 && name.length <= 256,
  ) || !/^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]*$/.test(model.id) || !isRecord(model.cost) ||
    !["input", "output", "cacheRead", "cacheWrite"].every((key) => Number.isFinite(model.cost[key]))) {
    throw new Error("Turn requires a complete Pi model");
  }
  if (!isRecord(options)) throw new Error("Turn options must be an object");
  const { headers: _headers, baseUrl: _baseUrl, ...modelMetadata } = model;
  const streamOptions = { signal, timeoutMs, sessionId };
  if (["minimal", "low", "medium", "high", "xhigh", "max"].includes(options.reasoning)) {
    streamOptions.reasoning = options.reasoning;
  }
  if (["none", "short", "long"].includes(options.cacheRetention)) {
    streamOptions.cacheRetention = options.cacheRetention;
    if (options.cacheRetention === "long") {
      streamOptions.env = { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" };
    } else if (options.cacheRetention === "none") {
      streamOptions.env = { DISABLE_PROMPT_CACHING: "1" };
    }
  }
  if (Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0) {
    streamOptions.maxTokens = options.maxTokens;
  }
  return [{ ...modelMetadata, baseUrl: "process://claude-code" }, { messages }, streamOptions];
}

function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function bounded(task, timeoutMs, message) {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await untilAborted(task, timeout);
  } catch (error) {
    if (timeout.aborted) throw new Error(message);
    throw error;
  }
}

function requireRelayedDone(event) {
  if (event.type !== "done") return;
  const diagnostics = event.message?.diagnostics;
  if (!Array.isArray(diagnostics) || !diagnostics.some((entry) =>
    entry?.type === "claude-code.turn-relay" && entry.details?.upstreamRequests === 1
  )) {
    throw new Error("Claude Code turn did not report exactly one upstream request through the guest relay");
  }
}

export function createGuestService(upstream, options = {}) {
  const turnTimeoutMs = options.turnTimeoutMs ?? TURN_TIMEOUT_MS;
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  const sessionId = options.sessionId ?? randomUUID();
  let committed;
  let active;
  let lastRequestId = 0;
  let stopped = false;
  let writeTail = Promise.resolve();

  function queuedWrite(output, frame, signal) {
    const write = writeTail.then(() => writeFrame(output, frame, { maxBytes: maxFrameBytes, signal }));
    writeTail = write.catch(() => {});
    return write;
  }

  async function closeWorker() {
    await bounded(upstream.closeClaudeProcesses(sessionId), CLEANUP_TIMEOUT_MS,
      "Claude Code worker cleanup did not complete");
  }

  async function runTurn(request, controller, output) {
    const requested = request.options?.timeoutMs;
    const timeoutMs = Number.isSafeInteger(requested) && requested > 0
      ? Math.min(turnTimeoutMs, requested) : turnTimeoutMs;
    const candidate = checkedTranscript(request.transcript, committed, maxFrameBytes);
    await queuedWrite(output, { id: request.id, type: "accepted", transcriptHash: candidate.hash }, controller.signal);
    const args = turnParameters(request, controller.signal, sessionId, timeoutMs, candidate.messages);
    const timer = setTimeout(() => controller.abort(new Error("Guest request timed out")), timeoutMs);
    let iterator;
    let successful = false;
    let cleaned = false;
    try {
      iterator = upstream.streamClaudeCode(...args)[Symbol.asyncIterator]();
      for (;;) {
        controller.signal.throwIfAborted();
        const { value: event, done } = await untilAborted(iterator.next(), controller.signal);
        controller.signal.throwIfAborted();
        if (done) throw new Error("Claude Code stream ended without a terminal event");
        requireRelayedDone(event);
        const terminal = event.type === "done" || event.type === "error";
        if (event.type === "error") {
          await closeWorker();
          cleaned = true;
        }
        await queuedWrite(output, { id: request.id, type: "event", event: compactAssistantEvent(event) }, controller.signal);
        if (terminal) {
          successful = event.type === "done";
          if (successful) committed = candidate;
          else committed = undefined;
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      if (iterator?.return) await Promise.resolve(iterator.return()).catch(() => {});
      if (!successful && !cleaned) {
        committed = undefined;
        await closeWorker();
      }
    }
  }

  async function handle(request, controller, output) {
    try {
      if (request.op === "status") {
        const timer = AbortSignal.any([controller.signal, AbortSignal.timeout(METADATA_TIMEOUT_MS)]);
        const status = await untilAborted(upstream.getClaudeStatus(undefined, timer), timer);
        const { available, loggedIn, subscription, plan } = status;
        await queuedWrite(output, { id: request.id, type: "value", value: {
          available, loggedIn, subscription, plan: plan ?? null,
        } }, controller.signal);
      } else if (request.op === "models") {
        const timer = AbortSignal.any([controller.signal, AbortSignal.timeout(METADATA_TIMEOUT_MS)]);
        let models;
        try {
          models = await untilAborted(upstream.discoverClaudeModels(undefined, timer), timer);
        } catch {
          throw new Error("Claude Code model discovery failed in the guest; check the CLI installation and login");
        }
        await queuedWrite(output, {
          id: request.id, type: "value", value: models.map((discovered) => {
            const mapped = upstream.modelFromDiscovery(discovered);
            if (discovered.supportsAdaptiveThinking !== true) return mapped;
            return {
              ...mapped,
              compat: { ...mapped.compat, forceAdaptiveThinking: true },
            };
          }),
        }, controller.signal);
      } else if (request.op === "turn") {
        await runTurn(request, controller, output);
      } else {
        throw new Error("Unknown guest operation");
      }
    } catch (error) {
      const failure = controller.signal.aborted ? controller.signal.reason : error;
      const fatal = error?.fatal === true;
      await queuedWrite(output, {
        id: request.id, type: "error", fatal,
        message: failure instanceof Error ? failure.message : "Guest operation failed",
      }).catch(() => {});
      if (fatal) throw error;
    }
  }

  return {
    get active() { return !!active; },
    get transcriptHash() { return committed?.hash; },
    async run(input, output) {
      if (stopped) throw new Error("Guest service cannot be restarted");
      output.write(`${READY}\n`);
      try {
        for await (const frame of readFrames(input, { maxBytes: maxFrameBytes })) {
          if (!isRecord(frame)) throw new Error("Protocol request must be an object");
          if (frame.type === "cancel") {
            if (!active && frame.id === lastRequestId) continue;
            if (!active || frame.id !== active.id) throw new Error("Cancel did not match the active request");
            active.controller.abort(new Error("Guest request cancelled"));
            continue;
          }
          if (!isId(frame.id) || !Number.isSafeInteger(frame.id) || frame.id <= lastRequestId) {
            throw new Error("Request IDs must be increasing positive integers");
          }
          lastRequestId = frame.id;
          if (active) {
            await queuedWrite(output, { id: frame.id, type: "error", fatal: false, message: "Guest service is busy" });
            continue;
          }
          const controller = new AbortController();
          const operation = { id: frame.id, controller, settled: undefined };
          operation.settled = handle(frame, controller, output).finally(() => {
            if (active === operation) active = undefined;
          });
          active = operation;
          void operation.settled.catch(() => {
            input.destroy();
            output.end();
          });
        }
      } finally {
        stopped = true;
        active?.controller.abort(new Error("Host closed the Cage service input"));
        await active?.settled?.catch(() => {});
        await bounded(upstream.closeClaudeProcesses(), CLEANUP_TIMEOUT_MS,
          "Claude Code process cleanup did not complete");
        await writeTail;
      }
    },
  };
}

function configureCliEnvironment() {
  const conflicts = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY"]
    .filter((name) => process.env[name]);
  for (const backend of ["BEDROCK", "VERTEX", "FOUNDRY"]) {
    const name = `CLAUDE_CODE_USE_${backend}`;
    const value = process.env[name]?.trim().toLowerCase();
    if (value && !["0", "false", "no", "off"].includes(value)) conflicts.push(name);
  }
  if (conflicts.length) throw new Error(`Claude Code subscription refuses guest auth/backend overrides: ${conflicts.join(", ")}`);

  const home = homedir();
  const env = {
    HOME: home,
    PATH: [dirname(realpathSync(process.execPath)), `${home}/.local/bin`, "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
  };
  for (const name of [
    "USER", "LOGNAME", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
    "DISABLE_TELEMETRY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DO_NOT_TRACK", "DISABLE_GROWTHBOOK",
    "DISABLE_AUTOUPDATER", "DISABLE_UPDATES",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, env);
}

async function main() {
  if (!process.argv.includes("--stdio")) throw new Error("Start the guest with service.mjs --stdio");
  process.umask(0o077);
  const workingDirectory = mkdtempSync(join(tmpdir(), "pi-claude-cage."));
  chmodSync(workingDirectory, 0o700);
  process.chdir(workingDirectory);
  try {
    configureCliEnvironment();
    const [{ streamClaudeCode }, cli, { modelFromDiscovery }] = await Promise.all([
      import("./upstream/src/stream.ts"), import("./upstream/src/claude-cli.ts"), import("./upstream/src/model-catalog.ts"),
    ]);
    const service = createGuestService({ ...cli, modelFromDiscovery, streamClaudeCode });
    await service.run(process.stdin, process.stdout);
  } finally {
    process.chdir("/");
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Guest service failed");
    process.exitCode = 1;
  }
}

import { once } from "node:events";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_LINE_BYTES, REQUEST_TIMEOUT_MS, TURN_TIMEOUT_MS, encode, isId, isRecord, readLines,
} from "./protocol.mjs";

const METADATA_TIMEOUT_MS = 25_000;
const WRITE_TIMEOUT_MS = 5_000;

function checkedSessionId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new Error("This operation requires a sessionId (1–256 characters)");
  }
  return value;
}

function turnParameters(request, signal, sessionId, timeoutMs) {
  const { model, context, options = {} } = request;
  if (!isRecord(model) || ![model.id, model.provider, model.api].every(
    (name) => typeof name === "string" && name.length > 0 && name.length <= 256,
  ) || !/^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]*$/.test(model.id) || !isRecord(model.cost) ||
    !["input", "output", "cacheRead", "cacheWrite"].every((key) => Number.isFinite(model.cost[key]))) {
    throw new Error("Turn requires a complete Pi model");
  }
  if (!isRecord(context) || !Array.isArray(context.messages)) {
    throw new Error("Turn requires a Pi transcript with a messages array");
  }
  if (!isRecord(options)) throw new Error("Turn options must be an object");

  // The host identity is required for upstream replay matching. Transport and
  // authentication belong to the guest CLI, not to the host model or options.
  const { headers: _headers, baseUrl: _baseUrl, ...modelMetadata } = model;
  const streamOptions = { signal, timeoutMs, sessionId };
  if (["minimal", "low", "medium", "high", "xhigh", "max"].includes(options.reasoning)) {
    streamOptions.reasoning = options.reasoning;
  }
  if (["none", "short", "long"].includes(options.cacheRetention)) {
    streamOptions.cacheRetention = options.cacheRetention;
  }
  if (Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0) {
    streamOptions.maxTokens = options.maxTokens;
  }
  return [{ ...modelMetadata, baseUrl: "process://claude-code" }, { messages: context.messages }, streamOptions];
}

function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createGuestServer(upstream, { turnTimeoutMs = TURN_TIMEOUT_MS } = {}) {
  const sockets = new Set();
  const requests = new Set();
  const turns = new Map();
  const closures = new Map();

  async function closeSession(sessionId) {
    if (!closures.has(sessionId)) {
      const active = turns.get(sessionId);
      active?.controller.abort(new Error("Pi session closed"));
      const cleanup = active ? active.settled : upstream.closeClaudeProcesses(sessionId);
      closures.set(sessionId, Promise.resolve(cleanup).finally(() => closures.delete(sessionId)));
    }
    await closures.get(sessionId);
  }

  async function turn(request, controller, timeoutMs, send) {
    const sessionId = checkedSessionId(request.sessionId);
    if (turns.has(sessionId) || closures.has(sessionId)) throw new Error("Pi session already has an active operation");
    const args = turnParameters(request, controller.signal, sessionId, timeoutMs);
    const settled = Promise.withResolvers();
    turns.set(sessionId, { controller, settled: settled.promise });
    let retain = false;
    let cleanup;
    const close = () => cleanup ??= upstream.closeClaudeProcesses(sessionId);
    let iterator;
    try {
      controller.signal.throwIfAborted();
      iterator = upstream.streamClaudeCode(...args)[Symbol.asyncIterator]();
      for (;;) {
        controller.signal.throwIfAborted();
        const { value: event, done } = await untilAborted(iterator.next(), controller.signal);
        controller.signal.throwIfAborted();
        if (done) throw new Error("Claude Code stream ended without a terminal event");
        const terminal = event.type === "done" || event.type === "error";
        if (event.type === "error") await close();
        await send({ type: "event", event }, terminal);
        if (terminal) {
          retain = event.type === "done" && !controller.signal.aborted;
          break;
        }
      }
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally {
      if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {});
      try {
        if (!retain) await close();
      } finally {
        turns.delete(sessionId);
        settled.resolve();
      }
    }
  }

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    const controller = new AbortController();
    let id = null;
    let started = false;
    let terminal = false;
    const readTimer = setTimeout(() => invalid("Timed out waiting for the guest request"), REQUEST_TIMEOUT_MS);

    async function send(frame, last = true) {
      if (terminal) throw new Error("Guest request already finished");
      controller.signal.throwIfAborted();
      await write(frame, last);
    }

    async function write(frame, last) {
      if (socket.destroyed || !socket.writable) throw new Error("Guest client disconnected");
      const line = encode({ id, ...frame });
      if (!last) {
        if (socket.writableLength > MAX_LINE_BYTES) throw new Error("Guest client stopped reading responses");
        socket.write(line);
        return;
      }
      terminal = true;
      const timer = setTimeout(() => socket.destroy(), WRITE_TIMEOUT_MS);
      try {
        await new Promise((resolve, reject) => {
          socket.write(line, (error) => error ? reject(error) : resolve());
        });
      } finally {
        clearTimeout(timer);
        socket.end(() => socket.destroy());
      }
    }

    function report(message) {
      if (terminal || socket.destroyed) return;
      void write({ type: "error", message }, true).catch(() => socket.destroy());
    }

    function invalid(message) {
      if (terminal) return;
      if (started) controller.abort(new Error(message));
      else {
        clearTimeout(readTimer);
        report(message);
      }
    }

    async function handle(request) {
      const { signal } = controller;
      const requestedTimeout = request.options?.timeoutMs;
      const timeoutMs = request.op === "turn"
        ? (Number.isSafeInteger(requestedTimeout) && requestedTimeout > 0
          ? Math.min(turnTimeoutMs, requestedTimeout) : turnTimeoutMs)
        : METADATA_TIMEOUT_MS;
      const timer = setTimeout(() => controller.abort(new Error("Guest request timed out")), timeoutMs);
      try {
        switch (request.op) {
          case "status": {
            const { available, loggedIn, subscription, plan } = await upstream.getClaudeStatus(undefined, signal);
            await send({ type: "value", value: { available, loggedIn, subscription, plan: plan ?? null } });
            break;
          }
          case "models": {
            let models;
            try {
              models = await upstream.discoverClaudeModels(undefined, signal);
            } catch {
              throw new Error("Claude Code model discovery failed in the guest; check the CLI installation and login");
            }
            await send({ type: "value", value: models.map(upstream.modelFromDiscovery) });
            break;
          }
          case "turn":
            await turn(request, controller, timeoutMs, send);
            break;
          case "close":
            await closeSession(checkedSessionId(request.sessionId));
            await send({ type: "value", value: null });
            break;
          default:
            throw new Error("Unknown guest operation");
        }
      } catch (error) {
        const failure = signal.aborted ? signal.reason : error;
        report(failure instanceof Error ? failure.message : "Guest operation failed");
      } finally {
        clearTimeout(timer);
      }
    }

    const stopReading = readLines(socket, (frame) => {
      if (terminal) return;
      if (started) {
        invalid(isRecord(frame) && frame.id === id && frame.type === "cancel"
          ? "Guest request cancelled" : "Only a matching cancel frame can follow the request");
        return;
      }
      if (!isRecord(frame) || !isId(frame.id)) {
        invalid("Request must include a valid id");
        return;
      }
      id = frame.id;
      started = true;
      clearTimeout(readTimer);
      const task = handle(frame);
      requests.add(task);
      void task.finally(() => requests.delete(task));
    }, invalid);

    socket.on("end", () => invalid("Guest client closed input"));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(readTimer);
      stopReading();
      sockets.delete(socket);
      if (!terminal) controller.abort(new Error("Guest client disconnected"));
    });
  });
  server.maxConnections = 32;

  async function stop() {
    const closed = new Promise((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
    await Promise.allSettled(requests);
    await upstream.closeClaudeProcesses();
  }
  return { server, stop };
}

function configureCliEnvironment() {
  // Do not silently switch account/backends if the guest has conflicting
  // overrides. Never hand these credentials to the status probe either.
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
    PATH: [dirname(realpathSync(process.execPath)), join(home, ".local/bin"), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
  };
  for (const name of [
    "USER", "LOGNAME", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
    "DISABLE_TELEMETRY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DO_NOT_TRACK", "DISABLE_GROWTHBOOK",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const name of ["PI_CLAUDE_CODE_COMMAND", "PI_CLAUDE_CODE_CONFIG_DIR", "CLAUDE_CONFIG_DIR"]) {
    const value = process.env[name];
    if (!value) continue;
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute guest path`);
    env[name] = value;
  }
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, env);
}

async function* requireRelayedTurn(events) {
  for await (const event of events) {
    // Upstream accepts CLI stdout without a request through the relay. That
    // path does not enforce the guest's transcript or one-request limit.
    if (event.type === "done") {
      const diagnostics = event.message?.diagnostics;
      if (!Array.isArray(diagnostics) || !diagnostics.some((entry) =>
        entry?.type === "claude-code.turn-relay" && entry.details?.upstreamRequests === 1
      )) {
        throw new Error("Claude Code turn did not report exactly one upstream request through the guest relay");
      }
    }
    yield event;
  }
}

async function main() {
  if (process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== "1") {
    throw new Error("Start the guest with pi-claude-cage.socket (systemd --user)");
  }
  process.umask(0o077);
  configureCliEnvironment();
  const [{ streamClaudeCode }, cli, { modelFromDiscovery }] = await Promise.all([
    import("./upstream/src/stream.ts"), import("./upstream/src/claude-cli.ts"), import("./upstream/src/model-catalog.ts"),
  ]);
  const { server, stop } = createGuestServer({
    ...cli, modelFromDiscovery,
    streamClaudeCode: (...args) => requireRelayedTurn(streamClaudeCode(...args)),
  });
  const listening = once(server, "listening");
  server.listen({ fd: 3 });
  await listening;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => void stop());
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`pi-claude-cage: ${error.message}`);
    process.exitCode = 1;
  }
}

import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const MAX_LINE_BYTES = 32 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;
export const TURN_TIMEOUT_MS = 180_000;
export const CLIENT_TIMEOUT_MS = TURN_TIMEOUT_MS + 20_000;

export function socketPath() {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  if (!isAbsolute(runtime)) throw new Error("Guest runtime directory is not absolute");
  const directory = join(runtime, "pi-claude-cage");
  const path = join(directory, "service.sock");
  const parent = lstatSync(directory);
  const socket = lstatSync(path);
  if (!parent.isDirectory() || !socket.isSocket() || [parent, socket].some(
    (entry) => entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0,
  )) {
    throw new Error("Guest socket is not private");
  }
  return path;
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isId(value) {
  return (typeof value === "string" && value.length > 0 && value.length <= 256) || Number.isSafeInteger(value);
}

export function isTerminal(frame) {
  return frame.type === "value" || frame.type === "error" ||
    (frame.type === "event" && ["done", "error"].includes(frame.event?.type));
}

export function encode(frame) {
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("Protocol line is too large");
  return `${line}\n`;
}

// Each transport uses newlines as frame boundaries, not individual read chunks.
export function readLines(stream, onFrame, onInvalid) {
  let parts = [];
  let size = 0;
  let stopped = false;
  function stop() {
    stopped = true;
    stream.off("data", onData);
    parts = [];
  }
  function onData(chunk) {
    let start = 0;
    while (!stopped && start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      size += end - start;
      if (size > MAX_LINE_BYTES) {
        stop();
        onInvalid("Protocol line is too large");
        return;
      }
      parts.push(chunk.subarray(start, end));
      if (newline < 0) return;
      const line = Buffer.concat(parts, size).toString("utf8");
      parts = [];
      size = 0;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        stop();
        onInvalid("Invalid protocol JSON");
        return;
      }
      onFrame(frame);
      start = newline + 1;
    }
  }
  stream.on("data", onData);
  return stop;
}

import { createConnection } from "node:net";
import {
  CLIENT_TIMEOUT_MS, MAX_LINE_BYTES, REQUEST_TIMEOUT_MS,
  encode, isId, isRecord, isTerminal, readLines, socketPath,
} from "./protocol.mjs";

// No dependencies, service imports, shell, or credential access in this process.
function runClient(input, output) {
  let id = null;
  let socket;
  let cancelled = false;
  let finished = false;
  let deadline;
  const done = Promise.withResolvers();

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    stopReading();
    input.destroy();
    socket?.destroy();
    done.resolve();
  }

  function fail(message) {
    if (finished) return;
    output.write(encode({ id, type: "error", message }));
    finish();
  }

  function onResponse(frame) {
    if (finished) return;
    if (!isRecord(frame) || frame.id !== id || !(
      (frame.type === "value" && Object.hasOwn(frame, "value")) ||
      (frame.type === "error" && typeof frame.message === "string") ||
      (frame.type === "event" && isRecord(frame.event) && typeof frame.event.type === "string")
    )) {
      fail("Invalid response from the guest service");
      return;
    }
    if (output.writableLength > MAX_LINE_BYTES) {
      fail("Host stopped reading guest responses");
      return;
    }
    output.write(encode(frame));
    if (isTerminal(frame)) finish();
  }

  function onRequest(frame) {
    if (finished) return;
    if (socket) {
      if (!cancelled && isRecord(frame) && frame.id === id && frame.type === "cancel") {
        cancelled = true;
        socket.end(encode({ id, type: "cancel" }));
      } else {
        fail("Only a matching cancel frame can follow the request");
      }
      return;
    }
    if (!isRecord(frame) || !isId(frame.id)) {
      fail("Request must include a valid id");
      return;
    }
    id = frame.id;
    try {
      socket = createConnection({ path: socketPath() });
      socket.once("error", () => fail("Cannot communicate with the guest service"));
      socket.once("close", () => fail("Guest service disconnected before a terminal response"));
      readLines(socket, onResponse, fail);
      socket.write(encode(frame));
    } catch {
      fail("Guest socket unavailable; check pi-claude-cage.socket in the guest");
      return;
    }
    clearTimeout(deadline);
    deadline = setTimeout(() => fail("Guest service response timed out"), CLIENT_TIMEOUT_MS);
  }

  output.on("error", finish);
  output.write('{"type":"ready","version":1}\n');
  const stopReading = readLines(input, onRequest, fail);
  input.once("end", () => {
    if (finished || cancelled) return;
    if (!socket) {
      fail("Host closed stdin before a request");
      return;
    }
    cancelled = true;
    socket.end();
  });
  input.once("error", () => fail("Cannot read the host request"));
  deadline = setTimeout(() => fail("Timed out waiting for the host request"), REQUEST_TIMEOUT_MS);
  return done.promise;
}

await runClient(process.stdin, process.stdout);

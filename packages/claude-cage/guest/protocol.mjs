export const PROTOCOL_VERSION = 2;
export const MAX_FRAME_BYTES = 256 * 1024 * 1024;
export const FRAME_WRITE_BYTES = 1024 * 1024;
export const TURN_TIMEOUT_MS = 20 * 60_000;
export const CLIENT_TIMEOUT_MS = TURN_TIMEOUT_MS + 20_000;

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isId(value) {
  return (typeof value === "string" && value.length > 0 && value.length <= 256) || Number.isSafeInteger(value);
}

export function encodeFrame(frame, maxBytes = MAX_FRAME_BYTES) {
  const json = JSON.stringify(frame);
  const bytes = Buffer.byteLength(json);
  if (bytes > maxBytes) throw new Error(`Protocol frame exceeds ${maxBytes} bytes`);
  return Buffer.from(`${json}\n`);
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

async function waitForDrain(stream, signal) {
  if (signal?.aborted) throw abortError(signal);
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", drained);
      stream.off("error", failed);
      stream.off("close", closed);
      signal?.removeEventListener("abort", aborted);
    };
    const settle = (callback, value) => { cleanup(); callback(value); };
    const drained = () => settle(resolve);
    const failed = (error) => settle(reject, error);
    const closed = () => settle(reject, new Error("Protocol output closed before drain"));
    const aborted = () => settle(reject, abortError(signal));
    stream.once("drain", drained);
    stream.once("error", failed);
    stream.once("close", closed);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export async function writeEncodedFrame(stream, body, options = {}) {
  const chunkBytes = options.chunkBytes ?? FRAME_WRITE_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error("chunkBytes must be a positive integer");
  if (!Buffer.isBuffer(body)) throw new Error("Encoded protocol frame must be a Buffer");
  for (let offset = 0; offset < body.length; offset += chunkBytes) {
    options.signal?.throwIfAborted();
    if (!stream.writable || stream.destroyed) throw new Error("Protocol output is not writable");
    if (!stream.write(body.subarray(offset, Math.min(body.length, offset + chunkBytes)))) {
      await waitForDrain(stream, options.signal);
    }
  }
}

export function writeFrame(stream, frame, options = {}) {
  const body = encodeFrame(frame, options.maxBytes ?? MAX_FRAME_BYTES);
  return writeEncodedFrame(stream, body, options);
}

export async function* readFrames(stream, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_FRAME_BYTES;
  let parts = [];
  let size = 0;
  for await (const chunk of stream) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - start;
      size += length;
      if (size > maxBytes) throw new Error(`Protocol frame exceeds ${maxBytes} bytes`);
      if (length) parts.push(chunk.subarray(start, end));
      if (newline < 0) break;
      const line = Buffer.concat(parts, size).toString("utf8");
      parts = [];
      size = 0;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        throw new Error("Invalid protocol JSON");
      }
      yield frame;
      start = newline + 1;
    }
  }
  if (size > 0 || parts.length > 0) throw new Error("Protocol ended with a partial frame");
}

function publicBlock(block, type) {
  if (!isRecord(block) || block.type !== type) throw new Error(`Invalid ${type} block`);
  const copy = structuredClone(block);
  delete copy.nativeIndex;
  delete copy.partialJson;
  return copy;
}

export function compactAssistantEvent(event) {
  if (!isRecord(event) || typeof event.type !== "string") throw new Error("Invalid assistant event");
  if (event.type === "done" || event.type === "error") return structuredClone(event);
  if (event.type === "start") {
    if (!isRecord(event.partial)) throw new Error("Assistant start omitted its partial message");
    return { type: "start", message: { ...structuredClone(event.partial), content: [] } };
  }
  const index = event.contentIndex;
  if (!Number.isSafeInteger(index) || index < 0 || !isRecord(event.partial) || !Array.isArray(event.partial.content)) {
    throw new Error("Assistant event omitted a valid content index or partial message");
  }
  const block = event.partial.content[index];
  switch (event.type) {
    case "text_start": {
      const start = publicBlock(block, "text");
      return { type: event.type, contentIndex: index, block: { ...start, text: "" } };
    }
    case "thinking_start": {
      const start = publicBlock(block, "thinking");
      return { type: event.type, contentIndex: index, block: start.redacted ? start : {
        ...start, thinking: "", thinkingSignature: "",
      } };
    }
    case "toolcall_start": {
      const start = publicBlock(block, "toolCall");
      return { type: event.type, contentIndex: index, block: { ...start, arguments: {} } };
    }
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      if (typeof event.delta !== "string") throw new Error("Assistant delta omitted its text");
      return { type: event.type, contentIndex: index, delta: event.delta };
    case "text_end":
      return { type: event.type, contentIndex: index, block: publicBlock(block, "text") };
    case "thinking_end":
      return { type: event.type, contentIndex: index, block: publicBlock(block, "thinking") };
    case "toolcall_end":
      return { type: event.type, contentIndex: index, block: publicBlock(event.toolCall ?? block, "toolCall") };
    default:
      throw new Error(`Unsupported assistant event: ${event.type}`);
  }
}

function parseToolArguments(json, current) {
  try {
    const value = JSON.parse(json);
    return isRecord(value) ? value : current;
  } catch {
    return current;
  }
}

export function createAssistantEventAssembler() {
  let partial;
  let terminal = false;
  const toolJson = new Map();

  function active(frame) {
    if (!partial || terminal) throw new Error(`Unexpected ${frame.type} assistant event`);
  }

  function indexed(frame, type) {
    active(frame);
    if (!Number.isSafeInteger(frame.contentIndex) || frame.contentIndex < 0 || frame.contentIndex >= partial.content.length) {
      throw new Error("Assistant event has an invalid content index");
    }
    const block = partial.content[frame.contentIndex];
    if (!isRecord(block) || block.type !== type) throw new Error(`Assistant event expected a ${type} block`);
    return block;
  }

  return {
    accept(frame) {
      if (!isRecord(frame) || typeof frame.type !== "string") throw new Error("Invalid compact assistant event");
      if (frame.type === "error") {
        if (terminal) throw new Error("Duplicate assistant terminal event");
        terminal = true;
        return structuredClone(frame);
      }
      if (frame.type === "done") {
        active(frame);
        if (!isRecord(frame.message) || JSON.stringify(frame.message.content) !== JSON.stringify(partial.content)) {
          throw new Error("Assistant terminal content differs from its incremental stream");
        }
        terminal = true;
        return structuredClone(frame);
      }
      if (frame.type === "start") {
        if (partial || terminal || !isRecord(frame.message) || !Array.isArray(frame.message.content) || frame.message.content.length) {
          throw new Error("Invalid assistant start event");
        }
        partial = structuredClone(frame.message);
        return { type: "start", partial };
      }
      if (frame.type.endsWith("_start")) {
        active(frame);
        if (frame.contentIndex !== partial.content.length || !isRecord(frame.block)) {
          throw new Error("Assistant block start is out of order");
        }
        partial.content.push(structuredClone(frame.block));
        if (frame.type === "toolcall_start") toolJson.set(frame.contentIndex, "");
        return { type: frame.type, contentIndex: frame.contentIndex, partial };
      }
      if (frame.type === "text_delta") {
        const block = indexed(frame, "text");
        if (typeof frame.delta !== "string") throw new Error("Invalid text delta");
        block.text += frame.delta;
        return { type: frame.type, contentIndex: frame.contentIndex, delta: frame.delta, partial };
      }
      if (frame.type === "thinking_delta") {
        const block = indexed(frame, "thinking");
        if (typeof frame.delta !== "string") throw new Error("Invalid thinking delta");
        block.thinking += frame.delta;
        return { type: frame.type, contentIndex: frame.contentIndex, delta: frame.delta, partial };
      }
      if (frame.type === "toolcall_delta") {
        const block = indexed(frame, "toolCall");
        if (typeof frame.delta !== "string") throw new Error("Invalid tool-call delta");
        const json = (toolJson.get(frame.contentIndex) ?? "") + frame.delta;
        toolJson.set(frame.contentIndex, json);
        block.arguments = parseToolArguments(json, block.arguments);
        return { type: frame.type, contentIndex: frame.contentIndex, delta: frame.delta, partial };
      }
      if (frame.type.endsWith("_end")) {
        const expected = frame.type === "text_end" ? "text" : frame.type === "thinking_end" ? "thinking" : "toolCall";
        indexed(frame, expected);
        if (!isRecord(frame.block) || frame.block.type !== expected) throw new Error("Invalid completed assistant block");
        partial.content[frame.contentIndex] = structuredClone(frame.block);
        toolJson.delete(frame.contentIndex);
        if (frame.type === "toolcall_end") {
          return { type: frame.type, contentIndex: frame.contentIndex, toolCall: partial.content[frame.contentIndex], partial };
        }
        return {
          type: frame.type, contentIndex: frame.contentIndex,
          content: expected === "text" ? frame.block.text : frame.block.thinking, partial,
        };
      }
      throw new Error(`Unsupported compact assistant event: ${frame.type}`);
    },
    get partial() { return partial; },
  };
}

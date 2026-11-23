import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

export const toolUse = {
  type: "tool_use", id: "toolu_01fixtureEcho", name: "mcp__pi__echo", input: { text: "from the model" },
};
const usage = { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 2 };

function messageEvents(message) {
  const { content: [block], stop_reason, usage, ...initial } = message;
  const isTool = block.type === "tool_use";
  return [
    { type: "message_start", message: { ...initial, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: isTool ? { ...block, input: {} } : { ...block, text: "" } },
    {
      type: "content_block_delta", index: 0,
      delta: isTool ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : { type: "text_delta", text: block.text },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason }, usage: { output_tokens: usage.output_tokens } },
    { type: "message_stop" },
  ];
}

export async function startFixtureUpstream(t) {
  const requests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/messages");
      assert.equal(request.headers["x-cage-fixture"], "cli");
      assert.equal(request.headers["accept-encoding"], "identity");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.model, "fixture-route");
      assert.equal(body.stream, true);
      const [last] = body.messages.at(-1).content;
      const prompt = last.type === "tool_result" ? "tool result" : last.text;
      const id = `fixture-request-${requests.length + 1}`;
      const entry = { body, id, prompt, disconnected: false };
      response.on("close", () => { entry.disconnected = !response.writableFinished; });
      requests.push(entry);
      response.writeHead(200, { "content-type": "text/event-stream", "request-id": id });
      if (prompt === "wait") {
        response.flushHeaders();
        return;
      }
      const isTool = prompt === "use a tool";
      const message = {
        id: `msg_${id}`, role: "assistant", usage,
        content: [isTool ? toolUse : { type: "text", text: `loopback answer: ${prompt}` }],
        stop_reason: isTool ? "tool_use" : "end_turn",
      };
      for (const event of messageEvents(message)) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    } catch (error) {
      errors.push(error);
      response.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
    assert.deepEqual(errors, []);
  });
  return { requests, port: server.address().port };
}

import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const arg = (flag) => args[args.indexOf(flag) + 1];
const emit = (value) => console.log(JSON.stringify(value));
const log = (entry) => appendFileSync(join(process.cwd(), "calls.jsonl"), `${JSON.stringify(entry)}\n`);
for (const name of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "UNTRUSTED", "PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS",
  "PI_CLAUDE_CAGE_FIXTURE_PORT"]) {
  assert.equal(process.env[name], undefined, name);
}
if (args[0] === "auth") {
  assert.deepEqual(args, ["auth", "status"]);
  assert.equal(process.env.ANTHROPIC_BASE_URL, undefined);
  emit({ loggedIn: true, subscriptionType: "max", email: "fixture-not-exported" });
  process.exit(0);
}

assert.equal(arg("--tools"), "");
assert.equal(arg("--setting-sources"), "");
assert(args.includes("--strict-mcp-config"));
assert(args.includes("--no-session-persistence"));
const model = arg("--model");
const discovery = model === "default";
let relay, extraBody, system;
if (discovery) {
  assert.equal(process.env.ANTHROPIC_BASE_URL, undefined);
} else {
  assert.equal(model, "fixture-route");
  assert.equal(arg("--max-turns"), "1");
  relay = new URL(process.env.ANTHROPIC_BASE_URL);
  assert.equal(relay.protocol, "http:");
  assert.equal(relay.hostname, "127.0.0.1");
  assert.match(relay.pathname, /^\/turn\/[^/]+$/);
  extraBody = JSON.parse(JSON.parse(readFileSync(arg("--settings"), "utf8")).env.CLAUDE_CODE_EXTRA_BODY);
  system = readFileSync(arg("--system-prompt-file"), "utf8");
  const config = JSON.parse(arg("--mcp-config")).mcpServers.pi;
  const manifest = JSON.parse(readFileSync(config.args[1], "utf8"));
  assert.deepEqual(manifest.map((tool) => tool.name), ["echo"]);
}

const history = [];
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const frame = JSON.parse(line);
  if (discovery) {
    if (frame.type === "control_request") {
      assert.equal(frame.request.subtype, "initialize");
      emit({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: {
        models: [{ value: "fixture-route", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Fixture", description: "Local only" }],
      } } });
    } else {
      assert.equal(frame.shouldQuery, false);
    }
    continue;
  }

  const { message, shouldQuery, uuid } = frame;
  assert.equal(frame.type, message.role);
  log({ pid: process.pid, message, query: message.role === "user" && shouldQuery !== false });
  history.push(message);
  if (message.role === "assistant") continue;
  if (shouldQuery === false) {
    emit({ type: "result", num_turns: 0, is_error: false });
    continue;
  }

  const [input] = message.content;
  let assistant;
  if (input.type === "tool_result" && input.content === "skip the relay") {
    // A shim has rewritten its route and can complete on stdout alone.
    assistant = {
      id: "stdout-only", role: "assistant", content: [{ type: "text", text: "stdout-only answer" }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    };
    emit({ type: "stream_event", event: { type: "message_stop" } });
    emit({ type: "assistant", message: assistant });
  } else {
    const messages = structuredClone(history);
    for (const entry of messages.filter(({ role }) => role === "user")) {
      for (const block of entry.content) {
        if (block.type === "tool_result") block.content += " (fixture CLI reminder)";
      }
      entry.content.push({ type: "text", text: "fixture CLI reminder" });
    }
    const response = await fetch(`${relay.href}/v1/messages`, {
      method: "POST", redirect: "error", headers: { "content-type": "application/json", "x-cage-fixture": "cli" },
      body: JSON.stringify({ ...extraBody, model, stream: true, system, messages }),
    });
    if (!response.ok) assert.fail(`Relay returned ${response.status}: ${await response.text()}`);
    const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    const start = events.find((event) => event.type === "message_start");
    const end = events.find((event) => event.type === "message_delta");
    const block = events.find((event) => event.type === "content_block_start").content_block;
    const { delta } = events.find((event) => event.type === "content_block_delta");
    if (block.type === "tool_use") block.input = JSON.parse(delta.partial_json);
    else block.text = delta.text;
    assistant = { ...start.message, ...end.delta, content: [block], usage: { ...start.message.usage, ...end.usage } };
  }
  history.push({ role: "assistant", content: assistant.content });
  if (input.text === "billing") emit({ type: "rate_limit_event", rate_limit_info: { isUsingOverage: true } });
  const tool = assistant.stop_reason === "tool_use";
  emit({ type: "result", subtype: tool ? "error_max_turns" : "success", is_error: tool, user_message_uuids: [uuid] });
}

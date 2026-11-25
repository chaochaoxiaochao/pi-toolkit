import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const installed = process.env.PI_CLAUDE_CAGE_TEST_INSTALL_DIR;
if (!installed) throw new Error("PI_CLAUDE_CAGE_TEST_INSTALL_DIR is required");

const { rewriteInitialRequest } = await import(pathToFileURL(join(installed, "upstream/src/claude-cli.ts")).href);
const marker = { type: "ephemeral", ttl: "1h" };
const text = (value) => ({ type: "text", text: value });
const marked = (value) => ({ ...text(value), cache_control: marker });
const count = (value) =>
  Array.isArray(value)
    ? value.reduce((sum, child) => sum + count(child), 0)
    : value && typeof value === "object"
      ? Object.entries(value).reduce((sum, [key, child]) => sum + (key === "cache_control" ? 1 : count(child)), 0)
      : 0;
const tools = [
  { name: "mcp__pi__read", input_schema: { type: "object" }, cache_control: marker },
  { name: "__pi_deferred_placeholder__", input_schema: { type: "object" }, defer_loading: true },
];
const system = [text("billing header"), marked("identity"), marked("system prompt")];
const environment = { role: "system", content: "environment reminder" };
const initialSystemMessages = [{ role: "system", content: [marked("environment reminder\ntoday's date")] }];
const frames = (users) => {
  const out = [];
  for (let index = 1; index <= users; index += 1) {
    out.push({ type: "user", message: { role: "user", content: [text(`question ${index}`)] } });
    if (index < users) out.push({ type: "assistant", message: { role: "assistant", content: [text(`answer ${index}`)] } });
  }
  return out;
};
const nativeBody = (users, warm) => {
  const messages = [];
  frames(users).forEach((frame, index) => {
    messages.push(structuredClone(frame.message));
    if (index === 0) messages.push(environment);
  });
  if (warm) messages.at(-1).content = [marked(`question ${users}`)];
  else messages.push({ role: "system", content: [marked("today's date")] });
  return { model: "claude-opus-5-5", tools, system, messages };
};
const update = [{ beforeAssistant: null, content: [text('Updated system prompt section "mcp_servers": fixture')] }];

let cases = 0;
for (const users of [2, 4]) {
  for (const warm of [true, false]) {
    for (const withUpdate of [false, true]) {
      const body = nativeBody(users, warm);
      const rewritten = JSON.parse(rewriteInitialRequest(
        Buffer.from(JSON.stringify(body)),
        frames(users),
        initialSystemMessages,
        withUpdate ? update : [],
      ).toString("utf8"));
      assert.ok(count(rewritten) <= 4,
        `${users} users, ${warm ? "warm" : "cold"}, ${withUpdate ? "with" : "without"} update`);
      cases += 1;
    }
  }
}

assert.equal(cases, 8);
console.log("PASS 8 cache-breakpoint request shapes");

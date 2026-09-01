import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverPackageAgents, parseAgentMarkdown } from "../src/personas.ts";
import { MAX_INLINE_BYTES, runTinySubagent } from "../src/runner.ts";

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
	if (condition) {
		passed += 1;
		console.log(`PASS ${name}`);
	} else {
		failed += 1;
		console.log(`FAIL ${name} ${detail}`);
	}
}

const root = mkdtempSync(join(tmpdir(), "pi-tiny-subagent-test-"));
const fakePi = join(root, "fake-pi.mjs");
writeFileSync(fakePi, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const capture = process.env.TINY_CAPTURE;
if (capture) appendFileSync(capture, JSON.stringify({ args, cwd: process.cwd(), child: process.env.PI_SUBAGENT_CHILD, promptFile: args[args.indexOf("--append-system-prompt") + 1] ? readFileSync(args[args.indexOf("--append-system-prompt") + 1], "utf8") : null }) + "\\n");
const mode = process.env.TINY_MODE || "success";
if (mode === "abort") { setTimeout(() => {}, 30000); }
if (mode === "success") {
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "fake/model", stopReason: "stop", content: [{ type: "text", text: "worker result" }] } }) + "\\n");
} else if (mode === "events") {
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "printf live" } }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "tool_result_end", message: { role: "toolResult", toolName: "bash", toolCallId: "call-1", isError: false, content: [{ type: "text", text: "live result" }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "fake/model", stopReason: "stop", content: [{ type: "text", text: "event result" }] } }) + "\\n");
} else if (mode === "error") {
  process.stderr.write("provider failed\\n");
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "rate limited", content: [] } }) + "\\n");
  process.exitCode = 7;
} else if (mode === "protocol") {
  process.stdout.write("not-json\\n");
  process.exitCode = 2;
} else if (mode === "large") {
  const text = "x".repeat(${MAX_INLINE_BYTES + 1000});
  process.stderr.write("e".repeat(${MAX_INLINE_BYTES + 1000}));
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } }) + "\\n");
}
`, { encoding: "utf8", mode: 0o700 });
chmodSync(fakePi, 0o700);

const capture = join(root, "capture.jsonl");
const oldEnv = { ...process.env };
function setEnv(values) {
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, oldEnv, values);
}
function restoreEnv() {
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, oldEnv);
}

try {
	setEnv({ PI_TINY_SUBAGENT_PI_BINARY: fakePi, TINY_CAPTURE: capture, TINY_MODE: "success" });
	const success = await runTinySubagent("hello", { cwd: root, model: "fake/model", tools: ["read"], systemPrompt: "You are a worker." });
	const launch = JSON.parse(readFileSync(capture, "utf8").trim());
	check("success output", success.ok && success.output === "worker result");
	check("model, tools, and fresh-process flags", launch.args.includes("--model") && launch.args.includes("fake/model") && launch.args.includes("--tools") && launch.args.includes("read") && launch.args.includes("--no-session") && launch.args.includes("--no-extensions") && launch.args.includes("--no-skills"));
	check("cwd and child marker", launch.cwd === root && launch.child === "1");
	check("persona system prompt file", launch.promptFile === "You are a worker.");

 setEnv({ PI_TINY_SUBAGENT_PI_BINARY: fakePi, TINY_MODE: "events" });
 const updates = [];
 const events = await runTinySubagent("events", { cwd: root, onUpdate: (partial) => updates.push(partial) });
 check("event transcript and live updates", events.ok && events.output === "event result" && events.messages.length === 3 && events.messages[0].content?.[0]?.type === "toolCall" && events.messages[1].role === "toolResult" && updates.length >= 4 && updates.at(-1).messages.length === 3);

	setEnv({ PI_TINY_SUBAGENT_PI_BINARY: fakePi, TINY_MODE: "error" });
	const error = await runTinySubagent("fail", { cwd: root });
	check("Pi error details", !error.ok && error.exitCode === 7 && error.stopReason === "error" && error.errorMessage === "rate limited" && error.stderr.includes("provider failed"));
	setEnv({ PI_TINY_SUBAGENT_PI_BINARY: fakePi, TINY_MODE: "protocol" });
	const protocol = await runTinySubagent("bad", { cwd: root });
	check("protocol error details", !protocol.ok && protocol.exitCode === 2 && protocol.protocolErrors.includes("not-json"));

	setEnv({ PI_TINY_SUBAGENT_PI_BINARY: "/definitely/missing/pi", TINY_MODE: "success" });
	const missing = await runTinySubagent("missing", { cwd: root });
	check("spawn error details", !missing.ok && missing.exitCode === 1 && missing.errorMessage?.includes("ENOENT"));

	setEnv({ PI_TINY_SUBAGENT_PI_BINARY: fakePi, TINY_MODE: "large" });
	const large = await runTinySubagent("large", { cwd: root });
	check("large output spills to artifacts", large.ok && large.artifacts && large.artifacts.cleanup.includes("remove directory") && large.output.includes("see artifact file") && large.outputBytes > MAX_INLINE_BYTES && large.artifacts.finalOutput && readFileSync(large.artifacts.finalOutput, "utf8").length > MAX_INLINE_BYTES);
	if (large.artifacts) rmSync(large.artifacts.directory, { recursive: true, force: true });

	setEnv({ PI_TINY_SUBAGENT_PI_BINARY: fakePi, TINY_MODE: "abort" });
	const controller = new AbortController();
	const pending = runTinySubagent("abort", { cwd: root, signal: controller.signal });
	setTimeout(() => controller.abort(), 50);
	const aborted = await pending;
	check("abort details", !aborted.ok && aborted.errorMessage === "Tiny subagent was aborted");

	const definition = parseAgentMarkdown(`---\nname: reviewer\ndescription: Review code\nmodel: fake/model\ntools: read, grep\n---\nReview carefully.`, "reviewer.md");
	check("persona frontmatter parsing", definition.name === "reviewer" && definition.model === "fake/model" && definition.tools?.join(",") === "read,grep" && definition.systemPrompt === "Review carefully.");
	const agentsDir = join(root, "agents");
	await import("node:fs/promises").then(({ mkdir }) => mkdir(agentsDir));
	writeFileSync(join(agentsDir, "worker.md"), `---\nname: worker\ndescription: Worker\n---\nDo work.`);
	writeFileSync(join(agentsDir, "broken.md"), "not frontmatter");
	const discovery = discoverPackageAgents(agentsDir);
	check("persona discovery and diagnostics", discovery.agents.length === 1 && discovery.agents[0].name === "worker" && discovery.diagnostics.length === 1);
} finally {
	restoreEnv();
	rmSync(root, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

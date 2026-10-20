import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piBinary } from "./runtime.mjs";

const directory = mkdtempSync(join(tmpdir(), "pi-bg-load-"));
const pkg = fileURLToPath(new URL("..", import.meta.url));
const toolkit = process.argv.includes("--toolkit");
const source = toolkit ? resolve(pkg, "../..") : resolve(pkg, "extensions/background-tasks.ts");
try {
	writeFileSync(join(directory, "settings.json"), JSON.stringify({ quietStartup: true, defaultTools: ["+codemode"] }));
	const output = execFileSync(piBinary, [
		"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
		"--no-session", "--offline", "-e", source,
		"-e", resolve(pkg, "tests/fixtures/provider.ts"), "--model", "bg-fixture/deterministic", "-p", "ping",
	], { cwd: directory, encoding: "utf8", timeout: 30000, env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1", BG_SMOKE_EVENTS: join(directory, "events.jsonl") }, stdio: ["ignore", "pipe", "pipe"] });
	assert.match(output, /Main agent is ready/);
	assert.doesNotMatch(output, /Failed to load|Error loading/);
	const events = readFileSync(join(directory, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const loaded = events.find((entry) => entry.event === "loaded");
	assert.equal(loaded.tools.filter((name) => name === "background_task").length, 1, "the real host registered exactly one background-task tool");
	const request = events.find((entry) => entry.event === "request");
	assert.equal(request.tools.filter((name) => name === "background_task").length, 1, "background_task is active in the model request without manual activation");
	console.log(`Real Pi loaded ${toolkit ? "the toolkit default loadout" : "the standalone background-task extension"} with exactly one background-task tool and an offline fixture provider.`);
} finally { rmSync(directory, { recursive: true, force: true }); }

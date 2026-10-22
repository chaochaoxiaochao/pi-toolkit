import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { piBinary } from "./runtime.mjs";

test("native Codemode receives start guidance and exposes it to the model", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-bg-guidance-"));
	try {
		const events = join(directory, "events.jsonl");
		const output = execFileSync(piBinary, [
			"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--offline",
			"-e", "builtin:codemode", "-e", fileURLToPath(new URL("../extensions/background-tasks.ts", import.meta.url)),
			"-e", fileURLToPath(new URL("fixtures/provider.ts", import.meta.url)),
			"--tools", "codemode,background_task", "--model", "bg-fixture/deterministic", "-p", "SMOKE_GUIDANCE",
		], { cwd: directory, encoding: "utf8", timeout: 30000,
			env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1", BG_SMOKE_EVENTS: events }, stdio: ["ignore", "pipe", "pipe"] });
		assert.match(output, /Main agent is ready/);
		const records = readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const started = records.find((entry) => entry.event === "tool_end" && entry.name === "background_task");
		assert.equal(started.isError, false);
		const guidance = started.result.structuredContent.guidance;
		assert.equal(guidance, "完成会自动通知。现在不要查询等待；继续其他独立工作，没有其他工作就结束当前轮，收到通知后再取结果。");
		const codemode = records.find((entry) => entry.event === "tool_end" && entry.name === "codemode");
		assert.equal(codemode.isError, false);
		assert.ok(codemode.result.content.some((block) => block.type === "text" && block.text.includes(guidance)));
		const requests = records.filter((entry) => entry.event === "request");
		assert.ok(requests[0].backgroundDescription.includes(guidance));
		assert.ok(requests[1].text.includes(guidance), "the next model request sees guidance printed from the programmatic result");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const mode of ["codemode", "direct"]) {
	for (const reads of [0, 1, 4]) {
		test(`real Pi ${mode} merges four completions before the next model call, excluding ${reads} consumed results`, () => {
			const directory = mkdtempSync(join(tmpdir(), "pi-bg-notifications-"));
			try {
				const events = join(directory, "events.jsonl");
				writeFileSync(join(directory, "settings.json"), JSON.stringify({ quietStartup: true, followUpMode: "one-at-a-time", steeringMode: "one-at-a-time" }));
				const output = execFileSync(piBinary, [
					"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--offline",
					"-e", "builtin:codemode", "-e", process.env.BG_TEST_EXTENSION ?? fileURLToPath(new URL("../extensions/background-tasks.ts", import.meta.url)),
					"-e", fileURLToPath(new URL("fixtures/notifications.ts", import.meta.url)),
					"--tools", "codemode,background_task,synchronous_subagent_fixture", "--model", "bg-notifications/deterministic", "--mode", "json", "-p", "Run the synchronous subagent scenario",
				], { cwd: directory, encoding: "utf8", timeout: 30000, env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1", BG_NOTIFICATION_EVENTS: events, BG_NOTIFICATION_READS: String(reads), BG_NOTIFICATION_MODE: mode }, stdio: ["ignore", "pipe", "pipe"] });
				assert.doesNotMatch(output, /Failed to load|Error loading|Fixture shell jobs did not finish/);
				const records = readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line));
				const returned = records.find((entry) => entry.event === "returned");
				assert.ok(returned, `the blocking tool finished all real shell jobs\n${output}`);
				assert.equal(returned.tasks.length, 4);
				assert.ok(returned.tasks.every((task) => task.status === "failed" && task.exit_code === 7));
				const transcript = output.trim().split("\n").map((line) => JSON.parse(line));
				const notifications = transcript.filter((entry) =>
					(entry.type === "entry_appended" && entry.entry.customType === "background-task-finished") ||
					(entry.type === "message_start" && entry.message.customType === "background-task-finished")
				);
				assert.equal(notifications.length, reads === 4 ? 0 : 1);
				if (reads !== 4) {
					const message = notifications[0].entry ?? notifications[0].message;
					const tasks = message.details.tasks;
					assert.equal(tasks.length, 4 - reads);
					assert.ok(tasks.every((task) => !returned.consumed.includes(task.id)));
					const toolEnd = transcript.findIndex((entry) => entry.type === "tool_execution_end" && entry.toolName === "synchronous_subagent_fixture");
					assert.ok(toolEnd >= 0 && transcript.indexOf(notifications[0]) > toolEnd, "the notification cannot interrupt the synchronous tool");
					assert.match(message.content, /Ended at: \d{4}-/);
				}
				const requests = records.filter((entry) => entry.event === "request");
				assert.equal(requests.length, mode === "direct" ? 3 : 2, "no extra model turns after the final report");
				const nextContext = JSON.stringify(requests.at(-1).messages);
				assert.equal((nextContext.match(/\[Background task finished\]/g) ?? []).length, reads === 4 ? 0 : 1);
				assert.doesNotMatch(nextContext, /FINAL_REPORT/, "completion is delivered before, not after, the final report");
				const contextText = requests.at(-1).messages.flatMap((message) => typeof message.content === "string" ? [message.content] : (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text)).join("\n");
				for (const task of returned.tasks.filter((task) => !returned.consumed.includes(task.id))) assert.ok(contextText.includes(task.id));
			} finally { rmSync(directory, { recursive: true, force: true }); }
		});
	}
}

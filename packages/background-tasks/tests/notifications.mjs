import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { piBinary } from "./runtime.mjs";

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { default: registerBackgroundTasks } = await import(process.env.BG_TEST_EXTENSION
	? pathToFileURL(process.env.BG_TEST_EXTENSION).href : new URL("../extensions/background-tasks.ts", import.meta.url).href);

async function waitFor(check, label) {
	for (let i = 0; i < 1000; i++) {
		if (check()) return;
		await delay(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

test("native model receives distinct declaration and start guidance without Codemode instructions", () => {
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
		const notice = "Completion will resume you automatically. Continue independent work if any remains; otherwise end the turn now. Do not call Bash sleep, tail logs, or use list/output solely to wait.";
		assert.equal(started.result.structuredContent.guidance, undefined);
		assert.equal(records.some((entry) => entry.event === "tool_end" && entry.name === "codemode"), false);
		const requests = records.filter((entry) => entry.event === "request");
		assert.match(requests[0].backgroundCommandDescription, /Stdout\/stderr are saved to a unique per-task log; its path is reported on completion\./);
		assert.match(requests[0].backgroundDescription, /automatic completion notifications/);
		assert.match(requests[0].backgroundDescription, /Use background_task for long-running commands or standalone waits/);
		assert.match(requests[0].backgroundDescription, /session-scoped and do not survive reload or exit/);
		assert.ok(!requests[0].backgroundDescription.includes(notice));
		assert.ok(!requests[0].backgroundDescription.includes("Codemode:"));
		assert.ok(requests[1].text.includes(notice), "the next model request sees the task-specific reminder");
		assert.match(requests[1].text, /Do not call Bash sleep/);
		assert.ok(!started.result.content[0].text.includes(started.result.structuredContent.task.log_path));
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("real Pi receives accelerated progress turns until the background task completes", { timeout: 20000 }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-bg-progress-"));
	const requests = [];
	let session;
	try {
		const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: join(directory, "models.json"), refreshOnCreate: false });
		modelRuntime.registerProvider("bg-progress", {
			name: "Offline progress fixture", baseUrl: "http://127.0.0.1:1", api: "bg-progress", apiKey: "fixture-not-a-secret",
			models: [{ id: "deterministic", name: "Offline fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			streamSimple(model, context) {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const last = context.messages.at(-1);
					const text = typeof last.content === "string" ? last.content : last.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
					requests.push(text);
					const start = last.role === "user" && text.includes("SMOKE_PROGRESS");
					const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: start ? "toolUse" : "stop",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
					if (start) message.content.push({ type: "toolCall", id: "progress-start", name: "background_task", arguments: {
						action: "start", command: "sleep 0.6; printf 'PROGRESS COMPLETE\\n'", description: "Progress check", timeout: 5,
					} });
					else message.content.push({ type: "text", text: text.includes("[Background task finished]") ? "COMPLETION_ACK" : "PROGRESS_ACK" });
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason, message });
				});
				return stream;
			},
		});
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
		const resourceLoader = new DefaultResourceLoader({
			cwd: directory, agentDir: directory, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi) => registerBackgroundTasks(pi, { progressIntervalMs: 100 })],
		});
		await resourceLoader.reload();
		const created = await createAgentSession({
			cwd: directory, agentDir: directory, modelRuntime, model: modelRuntime.getModel("bg-progress", "deterministic"),
			thinkingLevel: "off", resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(directory), tools: ["background_task"],
		});
		session = created.session;
		assert.deepEqual(created.extensionsResult.errors, []);
		await session.bindExtensions({});
		await session.prompt("SMOKE_PROGRESS");
		const entries = (type) => session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === type);
		await waitFor(() => entries("background-task-progress").length >= 1, "accelerated progress notification");
		await waitFor(() => entries("background-task-finished").length === 1, "completion notification");
		await session.waitForIdle();
		const progress = entries("background-task-progress");
		assert.ok(progress.length >= 2, "the accelerated fixture must prove repeated progress turns");
		for (const message of progress) {
			assert.equal(message.details.tasks.length, 1);
			assert.match(message.content, /Progress check/);
			assert.match(message.content, /No action is required/);
			assert.doesNotMatch(message.content, /PROGRESS COMPLETE|Captured log:|Untrusted shell output/);
		}
		assert.ok(requests.some((text) => text.includes("[Background tasks still running]")));
		assert.ok(requests.some((text) => text.includes("[Background task finished]")));
		assert.equal(entries("background-task-finished").length, 1);
	} finally {
		if (session) {
			await session.abort();
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		rmSync(directory, { recursive: true, force: true });
	}
});

test("native Codemode cannot discover or call the model-only background tool", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-bg-exposure-"));
	try {
		const events = join(directory, "events.jsonl");
		const output = execFileSync(piBinary, [
			"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--offline",
			"-e", "builtin:codemode", "-e", fileURLToPath(new URL("../extensions/background-tasks.ts", import.meta.url)),
			"-e", fileURLToPath(new URL("fixtures/provider.ts", import.meta.url)),
			"--tools", "codemode,background_task", "--model", "bg-fixture/deterministic", "-p", "SMOKE_EXPOSURE",
		], { cwd: directory, encoding: "utf8", timeout: 30000,
			env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1", BG_SMOKE_EVENTS: events }, stdio: ["ignore", "pipe", "pipe"] });
		assert.match(output, /Main agent is ready/);
		const records = readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const codemode = records.find((entry) => entry.event === "tool_end" && entry.name === "codemode");
		assert.equal(codemode.isError, false);
		const text = codemode.result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		assert.match(text, /"discovered":false/);
		assert.match(text, /"available":false/);
		assert.match(text, /BACKGROUND_CALL_BLOCKED/);
		assert.doesNotMatch(text, /UNEXPECTED_SUCCESS/);
		assert.equal(records.some((entry) => entry.event === "tool_end" && entry.name === "background_task"), false);
		assert.equal(existsSync(join(directory, "should-not-exist")), false);
		assert.ok(records.find((entry) => entry.event === "request").tools.includes("background_task"));
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const mode of ["codemode", "direct"]) {
	for (const reads of [0, 1, 2]) {
		test(`real Pi ${mode} blocker merges four completions, excluding ${reads} model-read results`, () => {
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
				assert.equal(returned.consumed.length, reads);
				assert.ok(returned.tasks.filter((task) => returned.consumed.includes(task.id)).every((task) => task.status === "failed" && task.exit_code === 7));
				const transcript = output.trim().split("\n").map((line) => JSON.parse(line));
				const notifications = transcript.filter((entry) =>
					(entry.type === "entry_appended" && entry.entry.customType === "background-task-finished") ||
					(entry.type === "message_start" && entry.message.customType === "background-task-finished")
				);
				assert.equal(notifications.length, 1);
				const message = notifications[0].entry ?? notifications[0].message;
				const tasks = message.details.tasks;
				assert.equal(tasks.length, 4 - reads);
				assert.ok(tasks.every((task) => task.status === "failed" && task.exit_code === 7));
				assert.ok(tasks.every((task) => !returned.consumed.includes(task.id)));
				for (const task of tasks) assert.ok(message.content.includes(task.log_path), "completion provides the captured output location");
				assert.doesNotMatch(message.content, /RESULT wave/, "command output is not injected automatically");
				assert.match(message.content, /Inspect logs progressively as needed/);
				for (const task of returned.tasks.filter((task) => returned.consumed.includes(task.id))) assert.ok(!message.content.includes(`RESULT ${task.description}`), "consumed output is not delivered twice");
				assert.ok(Buffer.byteLength(message.content) <= 16384);
				assert.deepEqual([...returned.consumed, ...tasks.map((task) => task.id)].sort(), returned.tasks.map((task) => task.id).sort());
				const toolEnd = transcript.findLastIndex((entry) => entry.type === "tool_execution_end" && ["synchronous_subagent_fixture", "codemode"].includes(entry.toolName));
				assert.ok(toolEnd >= 0 && transcript.indexOf(notifications[0]) > toolEnd, "the notification cannot interrupt the synchronous tool");
				assert.match(message.content, /Ended at: \d{4}-/);
				const requests = records.filter((entry) => entry.event === "request");
				assert.equal(requests.length, 3, "no extra model turns after the final report");
				const nextContext = JSON.stringify(requests.at(-1).messages);
				assert.equal((nextContext.match(/\[Background task finished\]/g) ?? []).length, 1);
				assert.doesNotMatch(nextContext, /FINAL_REPORT/, "completion is delivered before, not after, the final report");
				const contextText = requests.at(-1).messages.flatMap((message) => typeof message.content === "string" ? [message.content] : (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text)).join("\n");
				for (const task of returned.tasks.filter((task) => !returned.consumed.includes(task.id))) {
					assert.ok(contextText.includes(task.id));
					assert.ok(contextText.includes(task.log_path), "the next model request can locate output for on-demand inspection");
				}
			} finally { rmSync(directory, { recursive: true, force: true }); }
		});
	}
}

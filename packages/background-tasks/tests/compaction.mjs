import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import "./runtime.mjs";

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { default: register } = await import(process.env.BG_TEST_EXTENSION
	? pathToFileURL(process.env.BG_TEST_EXTENSION).href : new URL("../extensions/background-tasks.ts", import.meta.url).href);

async function waitFor(check, label) {
	for (let i = 0; i < 1000; i++) {
		if (check()) return;
		await delay(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

for (const outcome of ["success", "failure", "cancel"]) {
	test(`real Pi manual compaction ${outcome} delivers a job completed during summarization once, without another user prompt`, { timeout: 20000 }, async (t) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-bg-compact-"));
		const release = join(directory, "release");
		const exited = join(directory, "exited");
		const finishSummary = Promise.withResolvers();
		const requests = [], lifecycle = [], events = [], errors = [];
		let session, startedTask;
		try {
			const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: join(directory, "models.json"), refreshOnCreate: false });
			modelRuntime.registerProvider("bg-compaction", {
				name: "Offline real-compaction fixture", baseUrl: "http://127.0.0.1:1", api: "bg-compaction", apiKey: "fixture-not-a-secret",
				models: [{ id: "deterministic", name: "Offline fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
				streamSimple(model, context, options) {
					const stream = createAssistantMessageEventStream();
					const compacting = session.isCompacting;
					requests.push({ compacting, messages: context.messages });
					void (async () => {
						const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: "stop",
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
						try {
							if (compacting) {
								assert.ok(options.signal, "native summarization supplies its cancellation signal");
								writeFileSync(release, "release background shell\n");
								const aborted = () => finishSummary.resolve();
								options.signal.addEventListener("abort", aborted, { once: true });
								try { await finishSummary.promise; }
								finally { options.signal.removeEventListener("abort", aborted); }
								if (options.signal.aborted) {
									message.stopReason = "aborted";
									message.errorMessage = "Fixture summary aborted";
								} else if (outcome === "failure") {
									message.stopReason = "error";
									message.errorMessage = "Fixture summary failure";
								} else message.content.push({ type: "text", text: "## Goal\nVerify compaction delivery.\n## Progress\nA background shell remains owned by this session." });
							} else {
								const last = context.messages.at(-1);
								const text = typeof last.content === "string" ? last.content : last.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
								if (last.role === "user" && text.includes("START_COMPACTION_JOB")) {
									message.stopReason = "toolUse";
									message.content.push({ type: "toolCall", id: "compaction-start", name: "background_task", arguments: {
										action: "start", command: "while [ ! -f release ]; do sleep 0.01; done; printf 'finished during compaction\\n'; printf done > exited; exit 7", description: "Finishes during native compaction", timeout: 10,
									} });
								} else message.content.push({ type: "text", text: text.includes("[Background task finished]") ? "COMPLETION_ACK" : "JOB_ACCEPTED" });
							}
						} catch (error) {
							message.stopReason = "error";
							message.errorMessage = String(error);
						}
						stream.push({ type: "start", partial: message });
						if (["error", "aborted"].includes(message.stopReason)) stream.push({ type: "error", reason: message.stopReason, error: message });
						else stream.push({ type: "done", reason: message.stopReason, message });
					})();
					return stream;
				},
			});
			const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 128 }, retry: { enabled: false }, cacheWarming: "off" });
			const resourceLoader = new DefaultResourceLoader({
				cwd: directory, agentDir: directory, settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [register, (pi) => {
					for (const type of ["session_before_compact", "session_compact", "session_compact_failed"]) pi.on(type, (event, ctx) => {
						lifecycle.push({ type, reason: event.reason, aborted: event.aborted, fromExtension: event.fromExtension, idle: ctx.isIdle() });
					});
				}],
			});
			await resourceLoader.reload();
			const created = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model: modelRuntime.getModel("bg-compaction", "deterministic"), thinkingLevel: "off", resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(directory), tools: ["background_task"] });
			session = created.session;
			assert.deepEqual(created.extensionsResult.errors, []);
			session.extensionRunner.onError((error) => errors.push(error));
			session.subscribe((event) => {
				events.push({ ...event, observedAt: Date.now() });
				if (event.type === "tool_execution_end" && event.toolName === "background_task") startedTask = event.result.structuredContent.task;
			});
			await session.bindExtensions({});
			await session.prompt("Earlier context to summarize: " + "background verification history ".repeat(200));
			await session.prompt("START_COMPACTION_JOB");
			assert.equal(startedTask?.status, "running");
			assert.equal(session.isIdle, true);
			const notifications = () => session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "background-task-finished");
			const conversationRequests = () => requests.filter((request) => !request.compacting);
			const before = conversationRequests().length;
			// This is the same public manual-compaction entry point used by /compact and RPC.
			const compacting = session.compact("COMPACTION_DELIVERY_FIXTURE").then((value) => ({ value }), (error) => ({ error }));
			await waitFor(() => lifecycle.some((event) => event.type === "session_before_compact"), "native compaction start");
			await waitFor(() => requests.some((request) => request.compacting), "native summarizer request");
			await waitFor(() => existsSync(exited), "real background shell exit marker");
			await delay(1250); // Let the real first retry run while native compaction is still busy.
			assert.equal(session.isCompacting, true);
			assert.equal(session.isIdle, false);
			assert.equal(notifications().length, 0, "completion cannot interrupt native compaction");
			assert.equal(conversationRequests().length, before, "busy retries must not start another conversation request");
			if (outcome === "cancel") session.abortCompaction();
			else finishSummary.resolve();
			const result = await compacting;
			if (outcome === "success") {
				assert.equal(result.error, undefined);
				assert.match(result.value.summary, /Verify compaction delivery/);
			} else {
				assert.ok(result.error, "native compaction must reject on failure or cancellation");
				if (outcome === "failure") assert.match(result.error.message, /Fixture summary failure/);
			}
			assert.equal(session.isCompacting, false);
			assert.deepEqual(lifecycle.map((event) => event.type), ["session_before_compact", outcome === "success" ? "session_compact" : "session_compact_failed"]);
			assert.ok(lifecycle.every((event) => event.reason === "manual"));
			assert.equal(lifecycle[1].fromExtension, false, "the fixture must not supply a replacement compaction result");
			if (outcome !== "success") assert.equal(lifecycle[1].aborted, outcome === "cancel");
			await waitFor(() => notifications().length > 0, "automatic completion delivery after compaction");
			await session.waitForIdle();
			await delay(50);
			assert.equal(notifications().length, 1);
			assert.equal(conversationRequests().length, before + 1, "no user prompt is submitted after compact()");
			const notification = notifications()[0];
			const task = notification.details.tasks[0];
			assert.equal(task.id, startedTask.id);
			assert.equal(task.status, "failed");
			assert.equal(task.exit_code, 7);
			assert.match(readFileSync(task.log_path, "utf8"), /finished during compaction/);
			const start = events.find((event) => event.type === "compaction_start");
			const end = events.find((event) => event.type === "compaction_end");
			assert.ok(start && end, "native compaction lifecycle must actually run");
			assert.ok(task.ended_at >= start.observedAt && task.ended_at <= end.observedAt, "the actual task completed during compaction, not beforehand");
			assert.equal(end.aborted, outcome === "cancel");
			assert.equal(session.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, outcome === "success" ? 1 : 0);
			assert.equal(session.getLastAssistantText(), "COMPLETION_ACK");
			assert.deepEqual(errors, []);
			t.diagnostic(JSON.stringify({
				outcome, lifecycle, taskCompletedDuringCompaction: true,
				summaryRequests: requests.filter((request) => request.compacting).length,
				automaticConversationRequests: conversationRequests().length - before,
				completionEntries: notifications().length,
			}));
		} finally {
			finishSummary.resolve();
			if (session) {
				session.abortCompaction();
				await session.abort();
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

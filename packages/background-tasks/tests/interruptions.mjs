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
const { Type } = await import("typebox");
const { default: register } = await import(process.env.BG_TEST_EXTENSION
	? pathToFileURL(process.env.BG_TEST_EXTENSION).href : new URL("../extensions/background-tasks.ts", import.meta.url).href);

for (const timing of ["before interrupt", "after interrupt", "after active compaction"]) {
	test(`real Pi completion ${timing} stays stopped until the next user prompt, then delivers once`, { timeout: 20000 }, async (t) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-bg-interrupt-"));
		const release = join(directory, "release");
		const exited = join(directory, "exited");
		const requests = [], settlements = [], errors = [];
		let session, task, output, holding = false, summaries = 0;
		const waitFor = async (check, label) => {
			for (let i = 0; i < 1000; i++) {
				if (check()) return;
				await delay(10);
			}
			throw new Error(`Timed out waiting for ${label}`);
		};
		try {
			const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: join(directory, "models.json"), refreshOnCreate: false });
			modelRuntime.registerProvider("bg-interrupt", {
				name: "Offline interrupt fixture", baseUrl: "http://127.0.0.1:1", api: "bg-interrupt", apiKey: "fixture-not-a-secret",
				models: [{ id: "deterministic", name: "Offline fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
				streamSimple(model, context) {
					const compacting = session.isCompacting;
					if (compacting) summaries++;
					else requests.push(context.messages);
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: "toolUse",
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
						if (compacting) {
							message.stopReason = "stop";
							message.content.push({ type: "text", text: "## Goal\nKeep the interrupted agent stopped. A shell job remains owned by this session." });
						} else if (requests.length === 1) message.content.push({ type: "toolCall", id: "start-job", name: "background_task", arguments: {
							action: "start", command: "while [ ! -f release ]; do sleep 0.01; done; printf 'late shell result\\n'; printf done > exited; exit 7", timeout: 10,
						} });
						else if (requests.length === 2) message.content.push({ type: "toolCall", id: "hold-turn", name: "interrupt_fixture", arguments: {} });
						else if (requests.length === 3) message.content.push({ type: "toolCall", id: "read-result", name: "background_task", arguments: { action: "output", id: task.id } });
						else {
							message.stopReason = "stop";
							message.content.push({ type: "text", text: "RESUMED_RESULT_ACK" });
						}
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: message.stopReason, message });
					});
					return stream;
				},
			});
			const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 128 }, retry: { enabled: false }, cacheWarming: "off" });
			const resourceLoader = new DefaultResourceLoader({
				cwd: directory, agentDir: directory, settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [register, (pi) => {
					pi.on("agent_settled", (event) => { settlements.push(event.aborted); });
					pi.registerTool({
						name: "interrupt_fixture", label: "Interrupt fixture", description: "Hold a real tool until the user interrupts the agent.",
						parameters: Type.Object({}),
						async execute(_id, _params, signal) {
							holding = true;
							assert.ok(signal);
							if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
							return { content: [{ type: "text", text: "User interrupted the held tool." }], details: undefined };
						},
					});
				}],
			});
			await resourceLoader.reload();
			const created = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model: modelRuntime.getModel("bg-interrupt", "deterministic"), thinkingLevel: "off", resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(directory), tools: ["background_task", "interrupt_fixture"] });
			session = created.session;
			assert.deepEqual(created.extensionsResult.errors, []);
			session.extensionRunner.onError((error) => errors.push(error));
			session.subscribe((event) => {
				if (event.type !== "tool_execution_end" || event.toolName !== "background_task") return;
				if (event.result.structuredContent.action === "start") task = event.result.structuredContent.task;
				else if (event.result.structuredContent.action === "output") output = event.result.structuredContent;
			});
			await session.bindExtensions({});
			const prompting = session.prompt("Start a job and hold the agent so the user can interrupt. " + "Prior history to compact. ".repeat(200));
			await waitFor(() => holding, "the real blocking tool");
			assert.equal(task.status, "running");
			if (timing === "before interrupt") {
				writeFileSync(release, "finish while the tool is held");
				await waitFor(() => existsSync(exited), "the background shell exit marker");
				await delay(100);
			}
			const interruptRequestedAt = Date.now();
			if (timing === "after active compaction") {
				await session.compact();
				assert.equal(summaries, 1, "manual compaction must run its native summary after interrupting the active agent");
			} else await session.abort();
			await prompting;
			const interruptedAt = Date.now();
			assert.deepEqual(settlements, [true], "native settlement must confirm the user interrupt");
			assert.equal(session.isIdle, true);
			writeFileSync(release, "finish after user interruption");
			await waitFor(() => existsSync(exited), "the background shell surviving the interrupt");
			await delay(1250);
			assert.equal(requests.length, 2, "late completion must not start a model request");
			assert.match(readFileSync(task.log_path, "utf8"), /late shell result/);
			assert.equal(session.isIdle, true);
			await session.prompt("Continue and inspect the completed job.");
			assert.equal(requests.length, 4);
			const resumedContext = JSON.stringify(requests[2]);
			assert.equal((resumedContext.match(/\[Background task finished\]/g) ?? []).length, 1, "retained completion enters context before the resumed model request");
			assert.ok(resumedContext.includes(task.id));
			assert.equal(output.task.exit_code, 7);
			assert.equal(output.output, "late shell result\n");
			await delay(50);
			assert.equal(requests.length, 4, "consumed completion must not trigger another turn");
			const notifications = session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "background-task-finished");
			assert.equal(notifications.length, 1);
			assert.equal(notifications[0].details.tasks[0].id, task.id);
			assert.equal(notifications[0].details.tasks[0].status, "failed");
			if (timing === "before interrupt") assert.ok(notifications[0].details.tasks[0].ended_at <= interruptRequestedAt);
			else assert.ok(notifications[0].details.tasks[0].ended_at >= interruptedAt);
			assert.equal(session.getLastAssistantText(), "RESUMED_RESULT_ACK");
			assert.deepEqual(errors, []);
			t.diagnostic(JSON.stringify({ timing, requestsBeforeResume: 2, requestsAfterResume: 4, pendingDeliveredOnce: true, lateResultRecovered: true }));
		} finally {
			if (session) {
				await session.abort();
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

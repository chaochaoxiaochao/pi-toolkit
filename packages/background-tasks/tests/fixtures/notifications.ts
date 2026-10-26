// Sequential fixture tools hold one native batch open; background calls remain model-issued.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	const record = (entry: unknown) => appendFileSync(process.env.BG_NOTIFICATION_EVENTS!, JSON.stringify(entry) + "\n");
	const tasks = new Map<string, any>();
	const consumed: string[] = [];
	let finished = false;
	pi.registerTool({
		name: "synchronous_subagent_fixture", label: "Synchronous subagent fixture",
		description: "Wait for two real shell jobs while holding one synchronous tool call open.",
		parameters: Type.Object({ wave: Type.Number() }), executionMode: "sequential",
		async execute(_id, { wave }, _signal, _update, ctx) {
			record({ event: "waiting", wave });
			writeFileSync(join(ctx.cwd, `release-${wave}`), "ready");
			for (let i = 0; i < 1000; i++) {
				if ([0, 1].every((job) => existsSync(join(ctx.cwd, `exited-${wave}-${job}`)))) {
					// Exit markers precede process exit. Let the native shell backend settle.
					await delay(100);
					if (wave === 1) finished = true;
					return { content: [{ type: "text", text: "Synchronous subagent returned; shell wave finished." }], details: undefined };
				}
				await delay(5);
			}
			throw new Error("Fixture shell jobs did not finish");
		},
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "background_task") return;
		const data = event.result.structuredContent as any;
		if (data?.task) tasks.set(data.task.id, data.task);
		if (data?.action === "output" && data.task.status !== "running") consumed.push(data.task.id);
	});
	pi.on("context", () => {
		if (finished) {
			record({ event: "returned", tasks: [...tasks.values()], consumed });
			finished = false;
		}
	});
	let requests = 0;
	pi.registerProvider("bg-notifications", {
		name: "Offline notification fixture", baseUrl: "http://127.0.0.1:1", api: "bg-notifications", apiKey: "fixture-not-a-secret",
		models: [{ id: "deterministic", name: "Offline notification fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				requests++;
				record({ event: "request", number: requests, messages: context.messages });
				const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: requests <= 2 ? "toolUse" : "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "start", partial: message });
				if (requests <= 2) {
					// First start a pair to obtain IDs. The second native batch waits, starts
					// another pair, waits again, and reads selected outputs before its boundary.
					const wave = requests - 1;
					if (requests === 2) message.content.push({ type: "toolCall", id: "wait-first-wave", name: "synchronous_subagent_fixture", arguments: { wave: 0 } });
					for (let i = 0; i < 2; i++) message.content.push({ type: "toolCall", id: `start-${wave}-${i}`, name: "background_task", arguments: {
						action: "start", command: `while [ ! -f release-${wave} ]; do sleep 0.01; done; printf 'wave ${wave}\\n'; touch exited-${wave}-${i}; exit 7`, description: `wave ${wave} job ${i}`, timeout: 10,
					} });
					if (requests === 2) {
						if (process.env.BG_NOTIFICATION_MODE === "codemode") message.content.push({ type: "toolCall", id: "wait-second-wave", name: "codemode", arguments: { code: "text(await tools.synchronous_subagent_fixture({ wave: 1 }));" } });
						else message.content.push({ type: "toolCall", id: "wait-second-wave", name: "synchronous_subagent_fixture", arguments: { wave: 1 } });
						// Only first-wave IDs are known to the model before this batch returns.
						const reads = Number(process.env.BG_NOTIFICATION_READS);
						for (const task of [...tasks.values()].slice(0, reads)) message.content.push({ type: "toolCall", id: `read-${task.id}`, name: "background_task", arguments: { action: "output", id: task.id } });
					}
					for (let i = 0; i < message.content.length; i++) {
						stream.push({ type: "toolcall_start", contentIndex: i, partial: message });
						stream.push({ type: "toolcall_end", contentIndex: i, toolCall: message.content[i], partial: message });
					}
				} else {
					message.content.push({ type: "text", text: "FINAL_REPORT" });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "FINAL_REPORT", partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: "FINAL_REPORT", partial: message });
				}
				stream.push({ type: "done", reason: message.stopReason, message });
			});
			return stream;
		},
	});
}

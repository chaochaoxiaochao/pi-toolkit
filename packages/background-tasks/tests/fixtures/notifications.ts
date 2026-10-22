// A blocking tool stands in for a synchronous subagent. Pi queues and shell jobs are real.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	const record = (entry: unknown) => appendFileSync(process.env.BG_NOTIFICATION_EVENTS!, JSON.stringify(entry) + "\n");
	pi.registerTool({
		name: "synchronous_subagent_fixture", label: "Synchronous subagent fixture",
		description: "Wait for four real shell jobs while holding one synchronous tool call open.",
		parameters: Type.Object({ reads: Type.Number() }),
		async execute(_id, { reads }, _signal, _update, ctx) {
			record({ event: "waiting" });
			writeFileSync(join(ctx.cwd, "release"), "ready");
			const list = async () => (await ctx.executeTool("background_task", { action: "list" })).result.structuredContent as any;
			const wait = async () => {
				for (let i = 0; i < 1000; i++) {
					const tasks = await list();
					if (tasks.running === 0) return tasks.tasks;
					await delay(5);
				}
				throw new Error("Fixture shell jobs did not finish");
			};
			await wait();
			for (let i = 0; i < 2; i++) await ctx.executeTool("background_task", {
				action: "start", command: "printf 'second wave\\n'; exit 7", description: `second wave ${i}`, timeout: 10,
			});
			const tasks = await wait();
			for (const task of tasks.slice(0, reads)) await ctx.executeTool("background_task", { action: "output", id: task.id });
			record({ event: "returned", tasks, consumed: tasks.slice(0, reads).map((task: any) => task.id) });
			return { content: [{ type: "text", text: "Synchronous subagent returned; final build report is ready." }], details: undefined };
		},
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
				const direct = process.env.BG_NOTIFICATION_MODE === "direct";
				const toolTurn = requests === 1 || (direct && requests === 2);
				const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: toolTurn ? "toolUse" : "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "start", partial: message });
				if (toolTurn) {
					const reads = Number(process.env.BG_NOTIFICATION_READS);
					if (direct && requests === 1) {
						for (let i = 0; i < 2; i++) message.content.push({ type: "toolCall", id: `direct-start-${i}`, name: "background_task", arguments: {
							action: "start", command: "while [ ! -f release ]; do sleep 0.01; done; printf 'first wave\\n'; exit 7", description: `first wave ${i}`, timeout: 10,
						} });
					} else if (direct) message.content.push({ type: "toolCall", id: "direct-blocking-tool", name: "synchronous_subagent_fixture", arguments: { reads } });
					else {
						const code = `for (let i = 0; i < 2; i++) text(await tools.background_task({ action: "start", command: "while [ ! -f release ]; do sleep 0.01; done; printf 'first wave\\\\n'; exit 7", description: "first wave " + i, timeout: 10 }));\ntext(await tools.synchronous_subagent_fixture({ reads: ${reads} }));`;
						message.content.push({ type: "toolCall", id: "notification-fixture", name: "codemode", arguments: { code } });
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

// Offline fixture only. No network, real credentials, or nested model calls.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const record = (entry: unknown) => {
		if (process.env.BG_SMOKE_EVENTS) appendFileSync(process.env.BG_SMOKE_EVENTS, JSON.stringify(entry) + "\n");
	};
	let sequence = 0;
	pi.registerProvider("bg-fixture", {
		name: "Offline background-task fixture", baseUrl: "http://127.0.0.1:1", api: "bg-fixture",
		apiKey: "fixture-not-a-secret",
		models: [{ id: "deterministic", name: "Offline fixture (no network)", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const last = context.messages.at(-1) as any;
				const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
				record({ event: "request", lastRole: last?.role, text: text.slice(0, 2000), tools: getCurrentTools(context.messages).map((tool) => tool.name) });
				let code: string | undefined;
				if (last?.role !== "toolResult") {
					if (text.includes("SMOKE_START")) code = `const a = await tools.background_task({ action: "start", command: "sleep 9; printf 'BUILD SUCCESSFUL\\\\n'", description: "Release build", timeout: 30 });
const b = await tools.background_task({ action: "start", command: "sleep 300", description: "Cancel this task", timeout: 300 });
const c = await tools.background_task({ action: "start", command: "printf third" });
text({ first: a.task.id, second: b.task.id, third: c });`;
					else if (text.includes("SMOKE_CANCEL")) code = `const list = await tools.background_task({ action: "list" });
const task = list.tasks.find(t => t.description === "Cancel this task");
text(await tools.background_task({ action: "cancel", id: task.id }));`;
					else if (text.includes("SMOKE_OUTPUT")) code = `const list = await tools.background_task({ action: "list" });
const task = list.tasks.find(t => t.description === "Release build");
const result = await tools.background_task({ action: "output", id: task.id });
text({ status: result.task.status, output: result.output });`;
					else if (text.includes("SMOKE_LONG")) code = `text(await tools.background_task({ action: "start", command: "echo $$ > shell.pid; sleep 300 & echo $! > child.pid; wait", description: "Lifecycle cleanup check", timeout: 300 }));`;
				}
				const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: code ? "toolUse" : "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "start", partial: message });
				if (code) {
					message.content.push({ type: "toolCall", id: `fixture-${++sequence}`, name: "codemode", arguments: { code } });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
				} else {
					const reply = text.includes("[Background task finished]") ? "BACKGROUND_FOLLOWUP_RECEIVED" : "Main agent is ready; accepted background tasks keep running.";
					message.content.push({ type: "text", text: reply });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: message });
				}
				stream.push({ type: "done", reason: message.stopReason, message });
			});
			return stream;
		},
	});
	pi.on("session_start", (_event, ctx) => {
		record({ event: "loaded", tools: pi.getAllTools().map((tool) => tool.name) });
		if (ctx.hasUI) ctx.ui.setTitle("Pi Background Tasks Smoke");
	});
	pi.on("tool_execution_end", (event) => record({ event: "tool_end", name: event.toolName, isError: event.isError, result: event.result }));
	pi.on("message_start", (event) => {
		if (event.message.role === "custom") record({ event: "custom", type: event.message.customType, details: event.message.details });
	});
}

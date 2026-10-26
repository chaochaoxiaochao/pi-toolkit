// Offline fixture only. No network, real credentials, or nested model calls.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const record = (entry: unknown) => {
		if (process.env.BG_SMOKE_EVENTS) appendFileSync(process.env.BG_SMOKE_EVENTS, JSON.stringify(entry) + "\n");
	};
	let sequence = 0;
	const tasks = new Map<string, any>();
	const observedNotifications = new Set<string>();
	pi.registerProvider("bg-fixture", {
		name: "Offline background-task fixture", baseUrl: "http://127.0.0.1:1", api: "bg-fixture",
		apiKey: "fixture-not-a-secret",
		models: [{ id: "deterministic", name: "Offline fixture (no network)", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const last = context.messages.at(-1) as any;
				const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
				const tools = getCurrentTools(context.messages);
				record({ event: "request", lastRole: last?.role, text: text.slice(0, 2000), tools: tools.map((tool) => tool.name),
					backgroundDescription: tools.find((tool) => tool.name === "background_task")?.description });
				const calls: { name: string; arguments: any }[] = [];
				const call = (args: any) => calls.push({ name: "background_task", arguments: args });
				if (last?.role !== "toolResult") {
					if (text.includes("SMOKE_START")) {
						call({ action: "start", command: "sleep 9; printf 'BUILD SUCCESSFUL\\n'", description: "Release build", timeout: 30 });
						call({ action: "start", command: "sleep 300", description: "Cancel this task", timeout: 300 });
						call({ action: "start", command: "printf third" });
					} else if (text.includes("SMOKE_CANCEL")) {
						call({ action: "cancel", id: tasks.get("Cancel this task").id });
					} else if (text.includes("SMOKE_OUTPUT")) {
						call({ action: "output", id: tasks.get("Release build").id });
					} else if (text.includes("SMOKE_LONG")) {
						call({ action: "start", command: "echo $$ > shell.pid; sleep 300 & echo $! > child.pid; wait", description: "Lifecycle cleanup check", timeout: 300 });
					} else if (text.includes("SMOKE_GUIDANCE")) {
						call({ action: "start", command: "sleep 300", description: "Guidance check", timeout: 300 });
					} else if (text.includes("SMOKE_EXPOSURE")) {
						calls.push({ name: "codemode", arguments: { code: `
text({ discovered: ALL_TOOLS.some(t => t.name === "background_task"), available: "background_task" in tools });
try { await tools.background_task({ action: "start", command: "touch should-not-exist" }); text("UNEXPECTED_SUCCESS"); }
catch { text("BACKGROUND_CALL_BLOCKED"); }` } });
					}
				}
				const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: calls.length ? "toolUse" : "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "start", partial: message });
				if (calls.length) {
					for (const call of calls) {
						const index = message.content.length;
						message.content.push({ type: "toolCall", id: `fixture-${++sequence}`, ...call });
						stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: message.content[index], partial: message });
					}
				} else {
					const reply = text.includes("[Background task finished]") ? "BACKGROUND_NOTIFICATION_RECEIVED" : "Main agent is ready; accepted background tasks keep running.";
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
	pi.on("agent_settled", () => record({ event: "settled" }));
	pi.on("tool_execution_end", (event) => {
		const data = event.result.structuredContent as any;
		if (event.toolName === "background_task" && data?.action === "start" && data.task) tasks.set(data.task.description, data.task);
		record({ event: "tool_end", name: event.toolName, isError: event.isError, result: event.result });
	});
	pi.on("context", (_event, ctx) => {
		// Both boundary entries and idle messages are persisted before the provider request.
		// Key by entry ID so two actual notifications for the same tasks remain observable.
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom_message" || observedNotifications.has(entry.id)) continue;
			observedNotifications.add(entry.id);
			record({ event: "custom", entryId: entry.id, type: entry.customType, details: entry.details });
		}
	});
}

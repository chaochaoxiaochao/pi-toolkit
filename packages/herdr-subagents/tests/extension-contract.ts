import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { registerHerdrSubagents } from "../extensions/herdr-subagents.ts";

function harness(execute: (...args: any[]) => Promise<any>) {
	const handlers = new Map<string, (...args: any[]) => any>();
	let tool: Record<string, any> | undefined;
	let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let widgetCalls = 0;
	let renderedLines: string[] = [];
	const editor = { kind: "editor" };
	const focusedPanes: string[] = [];
	const ui = {
		setWidget(_id: string, widget: unknown) {
			widgetCalls += 1;
			if (typeof widget === "function") (widget as (tui: unknown) => unknown)({ focusedComponent: editor });
		},
		onTerminalInput(callback: typeof terminalInput) { terminalInput = callback; return () => { terminalInput = undefined; }; },
		getEditorText() { return ""; },
		notify() {},
	};
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerTool(definition: Record<string, any>) { tool = definition; },
		registerCommand() {},
		sendMessage() {},
	};
	registerHerdrSubagents(pi as never, {
		herdr: { async focusPane(paneId: string) { focusedPanes.push(paneId); } } as never,
		execute: execute as never,
		isEditor: (value) => value === editor,
		createFleetWidget(lines) { renderedLines = lines; return new Container(); },
	});
	return {
		handlers,
		get tool() { return tool; },
		get terminalInput() { return terminalInput; },
		get widgetCalls() { return widgetCalls; },
		get renderedLines() { return renderedLines; },
		focusedPanes,
		ui,
	};
}

async function startHarness(instance: ReturnType<typeof harness>, cwd: string) {
	await instance.handlers.get("session_start")?.({}, {
		cwd,
		mode: "tui",
		ui: instance.ui,
		sessionManager: { getSessionId: () => "contract-session" },
	});
}

async function verifyPublicUiWiring() {
	const cwd = mkdtempSync(join(tmpdir(), "herdr-extension-contract-"));
	try {
		const blockedDetails = {
			runId: "blocked-run", label: "reviews", status: "blocked", summary: "second needs input", documents: [],
			activity: [
				{ index: 0, name: "first", status: "completed", paneId: "w1:p1" },
				{ index: 1, name: "second", status: "blocked", paneId: "w1:p2" },
			],
		};
		const responding = harness(async () => ({ content: [{ type: "text", text: "needs input" }], details: blockedDetails }));
		await startHarness(responding, cwd);
		if (!responding.tool) throw new Error("herdr_subagents was not registered for UI wiring test");
		await responding.tool.execute("call", { action: "respond", runId: "blocked-run", answer: "main" }, undefined, undefined, { cwd, ui: responding.ui });
		if (!responding.renderedLines.some((line) => line.includes("second") && line.includes("blocked"))) throw new Error("blocked response did not refresh Fleet rows");
		if (!responding.terminalInput?.("\u001b[B")?.consume || !responding.terminalInput?.("\u001b[B")?.consume || !responding.terminalInput?.("\r")?.consume) throw new Error("Fleet terminal input was not consumed while selecting");
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (responding.focusedPanes.join(",") !== "w1:p2") throw new Error("Enter did not focus the exact refreshed blocked pane");
		if (responding.terminalInput?.("x")?.consume) throw new Error("unrelated terminal input must pass through");

		let releaseFirst: ((value: unknown) => void) | undefined;
		const runningDetails = { runId: "active-run", label: "active", status: "running", summary: "working", documents: [], tasks: [], activity: [{ index: 0, name: "active task", status: "running", paneId: "w1:p3" }] };
		const background = harness(async (_params, _signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "working" }], details: runningDetails });
			return await new Promise((resolve) => { releaseFirst = resolve; });
		});
		await startHarness(background, cwd);
		if (!background.tool) throw new Error("herdr_subagents was not registered for queue wiring test");
		await background.tool.execute("first", { background: true, tasks: [{ name: "active task", prompt: "one" }] }, undefined, undefined, { cwd, ui: background.ui });
		const activeWidgetCalls = background.widgetCalls;
		await background.tool.execute("second", { background: true, tasks: [{ name: "queued task", prompt: "two" }] }, undefined, undefined, { cwd, ui: background.ui });
		if (background.widgetCalls !== activeWidgetCalls || !background.renderedLines.some((line) => line.includes("active task"))) throw new Error("queued background run replaced the active Fleet widget");
		releaseFirst?.({ content: [{ type: "text", text: "done" }], details: { ...runningDetails, status: "completed" } });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

await verifyPublicUiWiring();

export default function (_pi: ExtensionAPI) {
	let tool: Record<string, any> | undefined;
	const pi = {
		on() {},
		registerTool(definition: Record<string, any>) { tool = definition; },
		registerCommand() {},
		sendMessage() {},
	};

	registerHerdrSubagents(pi as never, { herdr: {} as never });
	if (!tool) throw new Error("herdr_subagents was not registered");
	const schema = tool.parameters as Record<string, any>;
	if (schema.type !== "object" || schema.anyOf || schema.oneOf) throw new Error("herdr_subagents parameters must be one flat object schema");
	const required = ["action", "runId", "answer", "task", "prompt", "agent", "label", "model", "tasks", "concurrency", "background"];
	for (const name of required) {
		if (!schema.properties?.[name]) throw new Error(`schema is missing property '${name}'`);
		if (!schema.properties[name].description) throw new Error(`schema property '${name}' has no description`);
	}
	for (const name of ["name", "prompt", "agent", "model"]) {
		const property = schema.properties.tasks.items.properties[name];
		if (!property?.description) throw new Error(`nested task property '${name}' has no description`);
	}
	if (!/Foreground calls block/.test(tool.description) || !/background batches return a run ID immediately/.test(tool.description)) {
		throw new Error("tool description does not distinguish foreground and background execution");
	}
}

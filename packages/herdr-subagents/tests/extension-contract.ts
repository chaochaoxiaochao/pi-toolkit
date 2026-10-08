import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { registerHerdrSubagents } from "../extensions/herdr-subagents.ts";

function harness(execute: (...args: any[]) => Promise<any>) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands: string[] = [];
	let tool: Record<string, any> | undefined;
	let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let widgetCalls = 0;
	let renderedLines: string[] = [];
	const editor = { kind: "editor" };
	const focusedPanes: string[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const ui = {
		setWidget(_id: string, widget: unknown) {
			widgetCalls += 1;
			if (typeof widget === "function") (widget as (tui: unknown) => unknown)({ focusedComponent: editor });
		},
		onTerminalInput(callback: typeof terminalInput) { terminalInput = callback; return () => { terminalInput = undefined; }; },
		getEditorText() { return ""; },
		notify(message: string, level?: string) { notifications.push({ message, level }); },
	};
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerTool(definition: Record<string, any>) { tool = definition; },
		registerCommand(name: string) { commands.push(name); },
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
		commands,
		get tool() { return tool; },
		get terminalInput() { return terminalInput; },
		get widgetCalls() { return widgetCalls; },
		get renderedLines() { return renderedLines; },
		focusedPanes,
		notifications,
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
		const renderedBlocked = responding.tool.renderResult({ content: [{ type: "text", text: "needs input" }], details: { agent: "explorer", status: "blocked", ok: false, summary: "Need input.", documents: [] } }, { isPartial: false }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }).render(100).join("\n");
		if (!renderedBlocked.includes("blocked") || renderedBlocked.includes("failed")) throw new Error("single-task blocked result did not render its authoritative status");
		await responding.tool.execute("call", { action: "respond", runId: "blocked-run", answer: "main" }, undefined, undefined, { cwd, ui: responding.ui });
		if (!responding.renderedLines.some((line) => line.includes("second") && line.includes("blocked"))) throw new Error("blocked response did not refresh Fleet rows");
		if (!responding.terminalInput?.("\u001b[B")?.consume || !responding.terminalInput?.("\u001b[B")?.consume || !responding.terminalInput?.("\r")?.consume) throw new Error("Fleet terminal input was not consumed while selecting");
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (responding.focusedPanes.join(",") !== "w1:p2") throw new Error("Enter did not focus the exact refreshed blocked pane");
		if (responding.terminalInput?.("x")?.consume) throw new Error("unrelated terminal input must pass through");

		let releaseFirst: ((value: unknown) => void) | undefined;
		let backgroundCalls = 0;
		const runningDetails = { runId: "active-run", label: "active", status: "running", summary: "working", documents: [], tasks: [], activity: [{ index: 0, name: "active task", status: "running", paneId: "w1:p3" }] };
		const background = harness(async (_params, _signal, onUpdate) => {
			backgroundCalls += 1;
			onUpdate?.({ content: [{ type: "text", text: "working" }], details: runningDetails });
			if (backgroundCalls > 1) return { content: [{ type: "text", text: "done" }], details: { ...runningDetails, status: "completed" } };
			return await new Promise((resolve) => { releaseFirst = resolve; });
		});
		await startHarness(background, cwd);
		if (!background.tool) throw new Error("herdr_subagents was not registered for queue wiring test");
		await background.tool.execute("first", { background: true, tasks: [{ name: "active task", prompt: "one" }] }, undefined, undefined, { cwd, ui: background.ui });
		const activeWidgetCalls = background.widgetCalls;
		await background.tool.execute("second", { background: true, tasks: [{ name: "queued task", prompt: "two" }] }, undefined, undefined, { cwd, ui: background.ui });
		if (background.widgetCalls !== activeWidgetCalls || !background.renderedLines.some((line) => line.includes("active task"))) throw new Error("queued background run replaced the active Fleet widget");
		releaseFirst?.({ content: [{ type: "text", text: "done" }], details: { ...runningDetails, status: "completed" } });
		await new Promise((resolve) => setTimeout(resolve, 10));

		const rejectedCwd = join(cwd, "rejected-background");
		mkdirSync(rejectedCwd, { recursive: true });
		const rejectedBackground = harness(async () => ({ content: [{ type: "text", text: "Unknown persona" }], details: { errorMessage: "Unknown persona" }, isError: true }));
		await startHarness(rejectedBackground, rejectedCwd);
		await rejectedBackground.tool?.execute("rejected", { background: true, tasks: [{ name: "invalid", prompt: "reject" }] }, undefined, undefined, { cwd: rejectedCwd, ui: rejectedBackground.ui });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const queueDirectory = join(rejectedCwd, ".pi", "herdr-subagents", "queue");
		if (existsSync(queueDirectory) && readdirSync(queueDirectory).some((name) => name.endsWith(".json"))) throw new Error("rejected background batch left a durable queue entry");

		let lateUpdate: ((response: any) => void) | undefined;
		const cleanupNotice = harness(async (_params, _signal, onUpdate) => {
			lateUpdate = onUpdate;
			return { content: [{ type: "text", text: "done" }], details: { status: "completed" } };
		});
		await startHarness(cleanupNotice, cwd);
		await cleanupNotice.tool?.execute("cleanup", { prompt: "inspect" }, undefined, undefined, { cwd, ui: cleanupNotice.ui });
		lateUpdate?.({ content: [{ type: "text", text: "Task results settled, but Herdr tab cleanup failed: busy" }], details: { status: "failed" } });
		if (!cleanupNotice.notifications.some(({ message, level }) => message.includes("cleanup failed") && level === "warning")) throw new Error("deferred foreground cleanup failure was not surfaced as a notification");

		const brokenRoot = join(cwd, "broken-recovery");
		mkdirSync(join(brokenRoot, ".pi", "herdr-subagents"), { recursive: true });
		writeFileSync(join(brokenRoot, ".pi", "herdr-subagents", "runs"), "not a directory");
		let resumedExecutions = 0;
		const recoveryFailure = harness(async () => {
			resumedExecutions += 1;
			return { content: [{ type: "text", text: "done" }], details: { runId: "after-recovery", label: "after recovery", status: "completed", summary: "done", documents: [], tasks: [], activity: [] } };
		});
		await startHarness(recoveryFailure, brokenRoot);
		await Promise.race([
			recoveryFailure.tool?.execute("after-recovery", { tasks: [{ name: "task", prompt: "continue" }] }, undefined, undefined, { cwd: brokenRoot, ui: recoveryFailure.ui }),
			new Promise((_, reject) => setTimeout(() => reject(new Error("dispatcher stayed paused after recovery failure")), 100)),
		]);
		if (resumedExecutions !== 1 || !recoveryFailure.notifications.some(({ message }) => message.includes("recovery could not inspect"))) throw new Error("recovery failure did not resume dispatch and notify the user");

		const sessionAbortRoot = join(cwd, "session-abort");
		mkdirSync(sessionAbortRoot, { recursive: true });
		let retainedSignal: AbortSignal | undefined;
		const sessionAbort = harness(async (_params, signal) => {
			retainedSignal = signal;
			return { content: [{ type: "text", text: "done" }], details: { status: "completed" } };
		});
		await startHarness(sessionAbort, sessionAbortRoot);
		await sessionAbort.tool?.execute("session-abort", { prompt: "inspect" }, undefined, undefined, { cwd: sessionAbortRoot, ui: sessionAbort.ui });
		if (!retainedSignal || retainedSignal.aborted) throw new Error("execution did not retain a live parent-session signal");
		await sessionAbort.handlers.get("session_shutdown")?.({}, { cwd: sessionAbortRoot, ui: sessionAbort.ui });
		if (!retainedSignal.aborted) throw new Error("parent shutdown did not abort deferred cleanup signal");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

const originalHerdrEnv = process.env.HERDR_ENV;
const originalWorkspaceId = process.env.HERDR_WORKSPACE_ID;
const originalChild = process.env.PI_HERDR_SUBAGENTS_CHILD;
try {
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.PI_HERDR_SUBAGENTS_CHILD;
	const outside = harness(async () => { throw new Error("unreachable"); });
	if (outside.tool || outside.commands.length || outside.handlers.size) throw new Error("Subagents registered outside Herdr");
	process.env.HERDR_ENV = "1";
	const missingWorkspace = harness(async () => { throw new Error("unreachable"); });
	if (missingWorkspace.tool || missingWorkspace.commands.length || missingWorkspace.handlers.size) throw new Error("Subagents registered without a Herdr workspace");
	process.env.HERDR_ENV = "0";
	process.env.HERDR_WORKSPACE_ID = "w1";
	const inactiveHerdr = harness(async () => { throw new Error("unreachable"); });
	if (inactiveHerdr.tool || inactiveHerdr.commands.length || inactiveHerdr.handlers.size) throw new Error("Subagents registered with HERDR_ENV=0");
	process.env.HERDR_ENV = "1";
	const inside = harness(async () => { throw new Error("unreachable"); });
	if (!inside.tool || !inside.commands.includes("herdr-subagents") || !inside.handlers.has("session_start")) throw new Error("Subagents did not register inside Herdr");
	process.env.PI_HERDR_SUBAGENTS_CHILD = "1";
	const child = harness(async () => { throw new Error("unreachable"); });
	if (child.tool || child.commands.length || child.handlers.size) throw new Error("Subagents registered inside a child Agent");
	delete process.env.PI_HERDR_SUBAGENTS_CHILD;
	await verifyPublicUiWiring();
} finally {
	if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = originalHerdrEnv;
	if (originalWorkspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
	else process.env.HERDR_WORKSPACE_ID = originalWorkspaceId;
	if (originalChild === undefined) delete process.env.PI_HERDR_SUBAGENTS_CHILD;
	else process.env.PI_HERDR_SUBAGENTS_CHILD = originalChild;
}

export default function (_pi: ExtensionAPI) {
	let tool: Record<string, any> | undefined;
	const pi = {
		on() {},
		registerTool(definition: Record<string, any>) { tool = definition; },
		registerCommand() {},
		sendMessage() {},
	};

	const previousHerdrEnv = process.env.HERDR_ENV;
	const previousWorkspaceId = process.env.HERDR_WORKSPACE_ID;
	const previousChild = process.env.PI_HERDR_SUBAGENTS_CHILD;
	try {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_WORKSPACE_ID = "w1";
		delete process.env.PI_HERDR_SUBAGENTS_CHILD;
		registerHerdrSubagents(pi as never, { herdr: {} as never });
	} finally {
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
		if (previousWorkspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
		else process.env.HERDR_WORKSPACE_ID = previousWorkspaceId;
		if (previousChild === undefined) delete process.env.PI_HERDR_SUBAGENTS_CHILD;
		else process.env.PI_HERDR_SUBAGENTS_CHILD = previousChild;
	}
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

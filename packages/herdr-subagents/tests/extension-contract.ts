import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { registerHerdrSubagents } from "../extensions/herdr-subagents.ts";

function harness(execute: (...args: any[]) => Promise<any>) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands: string[] = [];
	let tool: Record<string, any> | undefined;
	let controlTool: Record<string, any> | undefined;
	let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let renderedLines: string[] = [];
	const editor = { kind: "editor" };
	const focused = Promise.withResolvers<string>();
	const messages: unknown[] = [];
	const ui = {
		setWidget(_id: string, widget: unknown) {
			if (typeof widget === "function") (widget as (tui: unknown) => unknown)({ focusedComponent: editor });
		},
		onTerminalInput(callback: typeof terminalInput) { terminalInput = callback; return () => { terminalInput = undefined; }; },
		getEditorText() { return ""; },
		notify() {},
	};
	registerHerdrSubagents({
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerTool(definition: Record<string, any>) {
			if (definition.name === "herdr_subagents") tool = definition;
			if (definition.name === "herdr_subagents_control") controlTool = definition;
		},
		registerCommand(name: string) { commands.push(name); },
		sendMessage(message: unknown) { messages.push(message); },
	} as never, {
		herdr: { async focusPane(paneId: string) { focused.resolve(paneId); } } as never,
		execute: execute as never,
		executeControl: execute as never,
		isEditor: (value) => value === editor,
		createFleetWidget(lines) { renderedLines = lines; return new Container(); },
	});
	return {
		handlers, commands, focused, messages, ui,
		get tool() { return tool; },
		get controlTool() { return controlTool; },
		get terminalInput() { return terminalInput; },
		get renderedLines() { return renderedLines; },
	};
}

async function verifyPublicUiWiring() {
	const cwd = mkdtempSync(join(tmpdir(), "herdr-extension-contract-"));
	const started = Promise.withResolvers();
	const finish = Promise.withResolvers();
	let foreground: Promise<any> | undefined;
	let instance: ReturnType<typeof harness> | undefined;
	try {
		const failed = { index: 0, name: "first", status: "failed", summary: "failed", documents: [], paneId: "w1:p1" };
		const completed = { index: 1, name: "second", status: "completed", summary: "finished", documents: [], paneId: "w1:p2" };
		instance = harness(async (_params, _signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "one task still running" }], details: {
				runId: "foreground", label: "reviews", status: "running", summary: "working", tasks: [failed],
				activity: [failed, { ...completed, status: "running" }],
			} });
			started.resolve();
			await finish.promise;
			return { content: [{ type: "text", text: "all tasks settled" }], details: {
				runId: "foreground", label: "reviews", status: "partial", summary: "all tasks settled", documents: [],
				tasks: [failed, completed], activity: [failed, completed], effectiveConcurrency: 2, requestedConcurrency: 2,
			}, isError: true };
		});
		await instance.handlers.get("session_start")?.({}, {
			cwd, mode: "tui", ui: instance.ui, sessionManager: { getSessionId: () => "contract-session" },
		});
		assert.ok(instance.tool && instance.controlTool);
		let returned = false;
		foreground = instance.tool.execute("foreground", { concurrency: 2, tasks: [
			{ name: "first", prompt: "fail", agent: "explorer" },
			{ name: "second", prompt: "finish", agent: "explorer" },
		] }, undefined, undefined, { cwd, ui: instance.ui }).then((result: any) => { returned = true; return result; });
		await started.promise;
		assert.equal(returned, false, "a failed task must not detach its running sibling");
		assert.ok(instance.renderedLines.some((line) => line.includes("second") && line.includes("running")));
		assert.equal(instance.terminalInput?.("\u001b[B")?.consume, true);
		assert.equal(instance.terminalInput?.("\u001b[B")?.consume, true);
		assert.equal(instance.terminalInput?.("\r")?.consume, true);
		assert.equal(await instance.focused.promise, "w1:p2");
		assert.notEqual(instance.terminalInput?.("x")?.consume, true);
		finish.resolve();
		const result = await foreground;
		assert.equal(result.details.status, "partial");
		assert.deepEqual(result.details.tasks.map((task: any) => task.status), ["failed", "completed"]);
		assert.equal(result.details.earlyReturn, undefined);
		assert.equal(result.details.background, undefined);
		assert.equal(instance.messages.length, 0, "foreground results must not also send a background follow-up");
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		assert.match(instance.tool.renderResult(result, { isPartial: false }, theme).render(100).join("\n"), /partial/);
		// Historical blocked status remains renderable, but respond/resume is retired.
		const blocked = instance.tool.renderResult({ content: [], details: {
			label: "historical", status: "blocked", effectiveConcurrency: 1,
			tasks: [{ name: "old task", status: "blocked", summary: "Need input." }],
		} }, { isPartial: false }, theme).render(100).join("\n");
		assert.match(blocked, /blocked/);
		assert.doesNotMatch(blocked, /failed/);
	} finally {
		finish.resolve();
		try { await foreground; }
		finally {
			await instance?.handlers.get("session_shutdown")?.({}, { cwd, ui: instance.ui });
			rmSync(cwd, { recursive: true, force: true });
		}
	}
}

const environmentKeys = ["HERDR_ENV", "HERDR_WORKSPACE_ID", "PI_HERDR_SUBAGENTS_CHILD"] as const;
const originalEnvironment = environmentKeys.map((key) => [key, process.env[key]] as const);
try {
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.PI_HERDR_SUBAGENTS_CHILD;
	const unreachable = async () => { throw new Error("unreachable"); };
	function assertNotRegistered() {
		const instance = harness(unreachable);
		assert.equal(instance.tool, undefined);
		assert.equal(instance.controlTool, undefined);
		assert.equal(instance.commands.length, 0);
		assert.equal(instance.handlers.size, 0);
	}
	assertNotRegistered();
	process.env.HERDR_ENV = "1";
	assertNotRegistered();
	process.env.HERDR_ENV = "0";
	process.env.HERDR_WORKSPACE_ID = "w1";
	assertNotRegistered();
	process.env.HERDR_ENV = "1";
	process.env.PI_HERDR_SUBAGENTS_CHILD = "1";
	assertNotRegistered();
	delete process.env.PI_HERDR_SUBAGENTS_CHILD;
	const inside = harness(unreachable);
	assert.ok(inside.tool && inside.controlTool);
	assert.ok(inside.commands.includes("herdr-subagents"));
	assert.ok(inside.handlers.has("session_start") && inside.handlers.has("session_shutdown"));
	const schema = inside.tool.parameters;
	assert.equal(schema.type, "object");
	assert.equal(schema.anyOf, undefined);
	assert.equal(schema.oneOf, undefined);
	assert.deepEqual(Object.keys(schema.properties).sort(), ["concurrency", "label", "tasks"]);
	assert.ok(schema.required.includes("tasks"));
	for (const property of Object.values(schema.properties) as any[]) assert.ok(property.description);
	for (const name of ["name", "prompt", "agent", "model"]) assert.ok(schema.properties.tasks.items.properties[name].description);
	assert.deepEqual(inside.tool.prepareArguments({ prompt: "inspect", agent: "explorer", label: "probe" }), {
		tasks: [{ name: "probe", prompt: "inspect", agent: "explorer" }], label: "probe",
	});
	const controlSchema = inside.controlTool.parameters;
	assert.deepEqual(Object.keys(controlSchema.properties).sort(), ["action", "runId"]);
	assert.ok(controlSchema.required.includes("action"));
	for (const property of Object.values(controlSchema.properties) as any[]) assert.ok(property.description);
	const actions = controlSchema.properties.action.enum ?? controlSchema.properties.action.anyOf.map((entry: any) => entry.const);
	assert.deepEqual(actions, ["list", "status", "history", "cancel", "cleanup"]);
	await verifyPublicUiWiring();
} finally {
	for (const [key, value] of originalEnvironment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

export default function (_pi: ExtensionAPI) {
	console.log("PASS Herdr extension registration, schema and foreground UI contracts");
}

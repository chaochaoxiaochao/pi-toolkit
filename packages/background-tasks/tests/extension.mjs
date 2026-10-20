import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import register from "../extensions/background-tasks.ts";
import { fixture, flush } from "./helpers.mjs";

function harness(mode = "tui", hasUI = true) {
	const f = fixture();
	const handlers = new Map();
	const commands = new Map();
	const messages = [];
	const notices = [];
	const widgets = new Map([["scheduler", { render: () => ["Scheduler"] }], ["herdr-subagents", { render: () => ["Fleet"] }]]);
	const placements = new Map();
	const statuses = new Map();
	let tool, renders = 0;
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const ctx = {
		cwd: f.root, mode, hasUI,
		ui: {
			setWidget(key, factory, options) {
				if (!factory) { widgets.delete(key); return; }
				widgets.set(key, factory({ requestRender() { renders++; } }, theme));
				placements.set(key, options);
			},
			setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
			notify(message, level) { notices.push({ message, level }); },
		},
	};
	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerTool(value) { tool = value; },
		registerCommand(name, value) { commands.set(name, value); },
		sendMessage(message, options) { messages.push({ message, options }); },
	};
	register(pi, { operations: f.operations, clock: f.clock, logRoot: f.root });
	return {
		...f, handlers, commands, messages, notices, widgets, placements, statuses, ctx,
		get tool() { return tool; }, get renders() { return renders; },
		async close() {
			const closing = handlers.get("session_shutdown")({}, ctx);
			for (const call of f.calls) call.resolve();
			await closing;
			await f.close();
		},
	};
}

test("registration is compact, does not inject prompt rules or start session resources", async () => {
	const h = harness();
	try {
		assert.equal(h.tool.name, "background_task");
		assert.match(h.tool.description, /return task IDs immediately/);
		assert.ok(h.tool.description.length < 200);
		assert.equal(h.tool.promptGuidelines, undefined);
		assert.ok(h.tool.outputSchema);
		assert.equal(h.tool.annotations.readOnlyHint, false);
		assert.equal(h.tool.annotations.destructiveHint, true);
		assert.ok(!h.handlers.has("before_agent_start"));
		assert.equal(h.clock.timers.size, 0);
		assert.equal(h.calls.length, 0);
		assert.equal((await h.tool.execute("early", { action: "list" })).isError, true);
	} finally { await h.close(); }
});

test("tools, commands, widget and followUp share the same session jobs", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		const parentSignal = new AbortController();
		const result = await h.tool.execute("start", { action: "start", command: "sleep 60", description: "测试构建", timeout: 60 }, parentSignal.signal, undefined, h.ctx);
		assert.equal(result.isError, false);
		const job = result.structuredContent.task;
		assert.equal(job.status, "running");
		parentSignal.abort();
		assert.equal(h.calls[0].signal.aborted, false, "parent turn cancellation does not own the accepted background job");
		assert.deepEqual(h.placements.get("background-tasks"), { placement: "aboveEditor" });
		h.clock.advance(1000);
		const widget = h.widgets.get("background-tasks");
		assert.match(widget.render(140).join("\n"), /1s \/ 1m/);
		for (const width of [1, 8, 40, 80]) assert.ok(widget.render(width).every((line) => visibleWidth(line) <= width));
		assert.ok(h.widgets.has("scheduler") && h.widgets.has("herdr-subagents"));

		h.calls[0].onData(Buffer.from("logs only on explicit read\n"));
		await h.commands.get("bg").handler(`output ${job.id}`, h.ctx);
		assert.match(h.messages.at(-1).message.content, /logs only on explicit read/);
		assert.equal(h.messages.at(-1).options.triggerTurn, false);
		const output = await h.tool.execute("output", { action: "output", id: job.id });
		assert.equal(output.structuredContent.output, "logs only on explicit read\n");
		assert.equal(output.details.output, undefined);

		h.calls[0].resolve(7);
		await flush();
		const completed = h.messages.filter((m) => m.message.customType === "background-task-finished");
		assert.equal(completed.length, 1);
		assert.deepEqual(completed[0].options, { triggerTurn: true, deliverAs: "followUp" });
		assert.match(completed[0].message.content, /failed.*exit 7/);
		assert.ok(!completed[0].message.content.includes("logs only"));
		assert.match(h.widgets.get("background-tasks").render(140).join("\n"), /failed/);
		h.clock.advance(4999);
		assert.ok(h.widgets.has("background-tasks"));
		h.clock.advance(1);
		assert.equal(h.widgets.has("background-tasks"), false);
		assert.equal(h.clock.timers.size, 0);
		assert.equal((await h.tool.execute("history", { action: "output", id: job.id })).structuredContent.task.status, "failed");
		assert.ok(h.renders > 0);
	} finally { await h.close(); }
});

test("cancel and shutdown are idempotent; new sessions cannot receive old completions", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		const a = (await h.tool.execute("a", { action: "start", command: "first" })).structuredContent.task;
		const b = (await h.tool.execute("b", { action: "start", command: "second" })).structuredContent.task;
		assert.equal((await h.tool.execute("c", { action: "start", command: "third" })).isError, true);
		const cancel = h.tool.execute("cancel", { action: "cancel", id: a.id });
		h.calls[0].reject(new Error("aborted"));
		assert.equal((await cancel).structuredContent.task.status, "cancelled");
		const count = h.messages.length;
		await h.commands.get("bg").handler(`cancel ${a.id}`, h.ctx);
		assert.equal(h.messages.filter((m) => m.message.customType === "background-task-finished").length, 1);
		assert.equal(h.messages.length, count + 1, "only the explicit command acknowledgement is added");
		const shutdown = h.handlers.get("session_shutdown")({ reason: "reload" }, h.ctx);
		assert.equal(h.calls[1].signal.aborted, true);
		h.calls[1].resolve();
		await shutdown;
		await h.handlers.get("session_start")({ reason: "reload" }, h.ctx);
		assert.equal((await h.tool.execute("old", { action: "output", id: b.id })).isError, true);
		assert.equal(h.messages.filter((m) => m.message.customType === "background-task-finished").length, 1);
		assert.equal(h.clock.timers.size, 0);
		assert.ok(h.widgets.has("scheduler") && h.widgets.has("herdr-subagents"));
	} finally { await h.close(); }
});

for (const [mode, hasUI] of [["rpc", true], ["print", false], ["json", false]]) {
	test(`${mode}: tools work without a TUI or render timer`, async () => {
		const h = harness(mode, hasUI);
		try {
			await h.handlers.get("session_start")({}, h.ctx);
			const result = await h.tool.execute("job", { action: "start", command: "ok" });
			assert.equal(result.structuredContent.task.status, "running");
			assert.equal(h.widgets.has("background-tasks"), false);
			assert.equal(h.clock.timers.size, 1, "only the execution deadline exists");
			if (hasUI) assert.match(h.statuses.get("background-tasks"), /1\/2/);
			h.calls[0].resolve();
			await flush();
			assert.equal(h.clock.timers.size, 0);
			assert.equal(h.statuses.has("background-tasks"), false);
			assert.equal(h.messages.at(-1).options.deliverAs, "followUp");
		} finally { await h.close(); }
	});
}

test("bad actions, irrelevant fields, aborted acceptance and command syntax fail visibly", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		for (const params of [
			{ action: "other" }, { action: "start" }, { action: "list", command: "ignored" },
			{ action: "output" }, { action: "cancel", id: "unknown" },
			{ action: "start", command: "x", id: "irrelevant" },
		]) {
			const result = await h.tool.execute("bad", params);
			assert.equal(result.isError, true);
			assert.ok(result.structuredContent.error.length <= 500);
		}
		const abort = new AbortController(); abort.abort();
		assert.equal((await h.tool.execute("abort", { action: "start", command: "x" }, abort.signal)).isError, true);
		await h.commands.get("bg").handler("start echo hello", h.ctx);
		assert.equal(h.notices.at(-1).level, "error");
		assert.equal(h.calls.length, 0);
	} finally { await h.close(); }
});

for (const reason of ["new", "resume", "fork", "quit"]) {
	test(`${reason} shutdown suppresses old notifications, removes timers and isolates IDs`, async () => {
		const h = harness();
		try {
			await h.handlers.get("session_start")({}, h.ctx);
			const job = (await h.tool.execute("start", { action: "start", command: "pending" })).structuredContent.task;
			const stopping = h.handlers.get("session_shutdown")({ reason }, h.ctx);
			assert.equal(h.calls[0].signal.aborted, true);
			h.calls[0].reject(new Error("aborted"));
			await stopping;
			await h.handlers.get("session_start")({ reason }, h.ctx);
			assert.equal(h.messages.length, 0);
			assert.equal(h.clock.timers.size, 0);
			assert.equal((await h.tool.execute("old", { action: "output", id: job.id })).isError, true);
		} finally { await h.close(); }
	});
}

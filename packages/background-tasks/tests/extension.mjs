import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
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
	const idleChecks = [];
	let tool, renders = 0, idle = true;
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const ctx = {
		cwd: f.root, mode, hasUI, isIdle: () => { idleChecks.push(f.clock.now()); return idle; },
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
	register(pi, { operations: f.operations, clock: f.clock, logRoot: f.root, env: {} });
	return {
		...f, handlers, commands, messages, notices, widgets, placements, statuses, idleChecks, ctx,
		setIdle(value) { idle = value; },
		get tool() { return tool; }, get renders() { return renders; },
		async close() {
			const closing = handlers.get("session_shutdown")({}, ctx);
			for (const call of f.calls) call.resolve();
			await closing;
			await f.close();
		},
	};
}

test("completions during a synchronous tool are merged before the next model request", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		h.setIdle(false);
		for (const command of ["first", "second"]) await h.tool.execute(command, { action: "start", command });
		h.calls[0].resolve(1);
		h.calls[1].resolve(2);
		await flush();
		assert.equal(h.messages.length, 0, "busy completions must not enter an irrevocable host queue");
		assert.match(h.widgets.get("background-tasks").render(140).join("\n"), /failed/);
		const existing = { type: "custom", customType: "other-extension", data: { preserved: true } };
		const boundary = h.handlers.get("turn_end")({ entries: [existing], continue: true, outcome: "completed" }, h.ctx);
		assert.equal(boundary.continue, true);
		assert.equal(boundary.entries.length, 2);
		assert.deepEqual(boundary.entries[0], existing);
		assert.equal(boundary.entries[1].details.tasks.length, 2);
		assert.match(boundary.entries[1].content, /Ended at: 1970-01-01T00:00:01.000Z/);
		assert.equal(h.handlers.get("agent_before_settle")({ entries: [], outcome: "completed" }, h.ctx), undefined);
	} finally { await h.close(); }
});

test("a completion during manual compaction wakes after idle without another agent boundary", async () => {
	const h = harness("print", false);
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		await h.tool.execute("start", { action: "start", command: "first" });
		h.setIdle(false);
		h.calls[0].resolve();
		await flush();
		h.clock.advance(0);
		h.clock.advance(1000);
		assert.equal(h.messages.length, 0);
		h.setIdle(true); // Manual compaction succeeds, fails or is cancelled; none emits agent_settled.
		h.clock.advance(2000);
		assert.equal(h.messages.length, 1);
		assert.equal(h.clock.timers.size, 0);
	} finally { await h.close(); }
});

test("busy notification checks back off to 30 seconds without expiring unread results", async () => {
	const h = harness("print", false);
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		h.setIdle(false);
		await h.tool.execute("start", { action: "start", command: "first" });
		h.calls[0].resolve();
		await flush();
		const started = h.clock.now();
		h.clock.advance(91000);
		assert.deepEqual(h.idleChecks.map((time) => time - started), [0, 1000, 3000, 7000, 15000, 31000, 61000, 91000]);
		assert.equal(h.messages.length, 0);
		assert.equal(h.clock.timers.size, 1);
		h.clock.advance(24 * 60 * 60 * 1000);
		assert.equal(h.messages.length, 0, "no timeout may silently drop the unread batch");
		assert.equal(h.clock.timers.size, 1);
		h.setIdle(true);
		const checks = h.idleChecks.length;
		h.clock.advance(29999);
		assert.equal(h.idleChecks.length, checks);
		h.clock.advance(1);
		assert.equal(h.messages.length, 1);
		assert.equal(h.clock.timers.size, 0);
	} finally { await h.close(); }
});

test("new completions share the backed-off timer, while tool boundaries deliver immediately and reset backoff", async () => {
	const h = harness("print", false);
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		h.setIdle(false);
		await h.tool.execute("start", { action: "start", command: "first" });
		h.calls[0].resolve();
		await flush();
		h.clock.advance(61000);
		await h.tool.execute("second", { action: "start", command: "second" });
		h.calls[1].resolve();
		await flush();
		assert.equal(h.clock.timers.size, 1);
		const checks = h.idleChecks.length;
		h.clock.advance(0);
		assert.equal(h.idleChecks.length, checks, "a new completion must not restart an active backoff");
		const boundary = h.handlers.get("turn_end")({ entries: [], outcome: "completed" }, h.ctx);
		assert.equal(boundary.entries[0].details.tasks.length, 2);
		assert.equal(h.clock.timers.size, 0, "the boundary must not wait for the 30-second timer");
		await h.tool.execute("third", { action: "start", command: "third" });
		h.calls[2].resolve();
		await flush();
		h.clock.advance(0);
		assert.equal(h.idleChecks.length, checks + 1, "a fresh batch starts with an immediate check");
		h.clock.advance(999);
		assert.equal(h.idleChecks.length, checks + 1);
		h.clock.advance(1);
		assert.equal(h.idleChecks.length, checks + 2, "a fresh batch retries after one second, not thirty");
	} finally { await h.close(); }
});

for (const action of ["agent_before_settle", "output", "aborted", "error", "session_shutdown"]) {
	test(`${action} clears a capped notification retry without stale wakes`, async () => {
		const h = harness("print", false);
		try {
			await h.handlers.get("session_start")({}, h.ctx);
			h.setIdle(false);
			const task = (await h.tool.execute("start", { action: "start", command: "first" })).structuredContent.task;
			h.calls[0].resolve();
			await flush();
			h.clock.advance(61000);
			assert.equal(h.clock.timers.size, 1);
			if (action === "output") {
				await h.tool.execute("read", { action, id: task.id });
			} else if (action === "session_shutdown") {
				await h.handlers.get(action)({}, h.ctx);
				await h.handlers.get("session_start")({}, h.ctx);
			} else {
				const event = { entries: [], outcome: action === "agent_before_settle" ? "completed" : action };
				const boundary = h.handlers.get("agent_before_settle")(event, h.ctx);
				if (action === "agent_before_settle") assert.equal(boundary.entries[0].details.tasks[0].id, task.id);
				else assert.equal(boundary, undefined);
			}
			assert.equal(h.clock.timers.size, 0);
			h.setIdle(true);
			const checks = h.idleChecks.length;
			h.clock.advance(24 * 60 * 60 * 1000);
			assert.equal(h.idleChecks.length, checks);
			assert.equal(h.messages.length, 0);
		} finally { await h.close(); }
	});
}

test("failed terminal log reads do not consume pending completion", async () => {
	const h = harness("print", false);
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		h.setIdle(false);
		const task = (await h.tool.execute("start", { action: "start", command: "first" })).structuredContent.task;
		h.calls[0].resolve();
		await flush();
		unlinkSync(task.log_path);
		const result = await h.tool.execute("read", { action: "output", id: task.id });
		assert.equal(result.isError, true);
		assert.match(result.structuredContent.error, /Cannot read task log/);
		const boundary = h.handlers.get("turn_end")({ entries: [], outcome: "completed" }, h.ctx);
		assert.equal(boundary.entries[0].details.tasks[0].id, task.id);
	} finally { await h.close(); }
});

test("terminal output consumed by the agent removes only that pending reminder", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		h.setIdle(false);
		const a = (await h.tool.execute("a", { action: "start", command: "first" })).structuredContent.task;
		const b = (await h.tool.execute("b", { action: "start", command: "second" })).structuredContent.task;
		await h.tool.execute("running", { action: "output", id: b.id });
		h.calls[0].resolve(7);
		h.calls[1].resolve();
		await flush();
		await h.tool.execute("list", { action: "list" });
		await h.commands.get("bg").handler(`output ${b.id}`, h.ctx);
		const output = await h.tool.execute("read", { action: "output", id: a.id });
		assert.equal(output.isError, true, "a nonzero command is still a successful log read");
		const boundary = h.handlers.get("turn_end")({ entries: [], outcome: "completed" }, h.ctx);
		assert.deepEqual(boundary.entries[0].details.tasks.map((task) => task.id), [b.id]);
		assert.equal(h.messages.length, 1, "only the user's inspection message was sent");
	} finally { await h.close(); }
});

test("idle completions coalesce, but a newly busy session receives them at its next boundary", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		for (const command of ["first", "second"]) await h.tool.execute(command, { action: "start", command });
		h.calls[0].resolve();
		h.calls[1].resolve(1);
		await flush();
		assert.equal(h.messages.length, 0);
		h.setIdle(false);
		h.clock.advance(0);
		assert.equal(h.messages.length, 0, "idle wake must recheck state before sending");
		const boundary = h.handlers.get("agent_before_settle")({ entries: [], outcome: "completed" }, h.ctx);
		assert.equal(boundary.entries[0].details.tasks.length, 2);
		assert.equal(boundary.continue, true);
		assert.equal(h.handlers.get("turn_end")({ entries: [], outcome: "completed" }, h.ctx), undefined);
	} finally { await h.close(); }
});

test("idle wake batches current completions and a terminal read can remove the whole batch", async () => {
	const h = harness("print", false);
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		for (const command of ["first", "second"]) await h.tool.execute(command, { action: "start", command });
		h.calls[0].resolve();
		h.calls[1].resolve(1);
		await flush();
		h.clock.advance(0);
		assert.equal(h.messages.length, 1);
		assert.equal(h.messages[0].message.details.tasks.length, 2);
		const task = (await h.tool.execute("third", { action: "start", command: "third" })).structuredContent.task;
		h.calls[2].resolve();
		await flush();
		await h.tool.execute("read", { action: "output", id: task.id });
		h.clock.advance(0);
		assert.equal(h.messages.length, 1);
		assert.equal(h.clock.timers.size, 0);
	} finally { await h.close(); }
});

for (const outcome of ["aborted", "error"]) {
	test(`${outcome} boundaries do not force continuation or replay a scheduled idle wake`, async () => {
		const h = harness();
		try {
			await h.handlers.get("session_start")({}, h.ctx);
			await h.tool.execute("start", { action: "start", command: "first" });
			h.calls[0].resolve();
			await flush();
			h.setIdle(false);
			assert.equal(h.handlers.get("turn_end")({ entries: [], outcome }, h.ctx), undefined);
			assert.equal(h.handlers.get("agent_before_settle")({ entries: [], outcome }, h.ctx), undefined);
			h.handlers.get("agent_settled")({ aborted: outcome === "aborted" }, h.ctx);
			h.setIdle(true);
			h.clock.advance(0);
			assert.equal(h.messages.length, 0);
			if (outcome === "aborted") {
				const resumed = h.handlers.get("before_agent_start")({ messageType: "user", prompt: "Continue" }, h.ctx);
				assert.equal(resumed.message.details.tasks.length, 1, "the next user prompt receives retained results");
				assert.equal(h.handlers.get("turn_end")({ entries: [], outcome: "completed" }, h.ctx), undefined);
				return;
			}
			const boundary = h.handlers.get("turn_end")({ entries: [], outcome: "completed" }, h.ctx);
			assert.equal(boundary.entries[0].details.tasks.length, 1, "unread results remain available");
		} finally { await h.close(); }
	});
}

test("jobs finishing after a user interrupt stay queryable without restarting the agent until the next user prompt", async () => {
	const h = harness("print", false);
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		const tasks = [];
		for (const command of ["first", "second"]) {
			tasks.push((await h.tool.execute(command, { action: "start", command })).structuredContent.task);
		}
		h.setIdle(false);
		h.handlers.get("turn_end")({ entries: [], outcome: "aborted" }, h.ctx);
		h.handlers.get("agent_before_settle")({ entries: [], outcome: "aborted" }, h.ctx);
		h.handlers.get("agent_settled")({ aborted: true }, h.ctx);
		h.setIdle(true);
		for (const call of h.calls) {
			assert.equal(call.signal.aborted, false, "interrupting the agent must not cancel accepted jobs");
			call.resolve(7);
		}
		await flush();
		h.clock.advance(24 * 60 * 60 * 1000);
		assert.equal(h.messages.length, 0, "late completions must not restart the interrupted agent");
		assert.equal(h.clock.timers.size, 0);
		const list = await h.tool.execute("list", { action: "list" });
		assert.ok(list.structuredContent.tasks.every((task) => task.status === "failed"));
		assert.equal(h.handlers.get("before_agent_start")?.({ messageType: "custom" }, h.ctx), undefined);
		assert.equal(h.handlers.get("turn_end")({ entries: [], outcome: "completed" }, h.ctx), undefined, "another extension's run must not release the interrupt");
		const output = await h.tool.execute("read", { action: "output", id: tasks[0].id });
		assert.equal(output.structuredContent.task.exit_code, 7);
		const resumed = h.handlers.get("before_agent_start")({ messageType: "user", prompt: "Continue" }, h.ctx);
		assert.deepEqual(resumed.message.details.tasks.map((task) => task.id), [tasks[1].id]);
		assert.equal(h.handlers.get("turn_end")({ entries: [], outcome: "completed" }, h.ctx), undefined);
		await h.tool.execute("new", { action: "start", command: "new" });
		h.calls[2].resolve();
		await flush();
		h.clock.advance(0);
		assert.equal(h.messages.length, 1, "the user prompt restores normal automatic delivery");
	} finally { await h.close(); }
});

test("registration is compact, does not inject prompt rules or start session resources", async () => {
	const h = harness();
	try {
		assert.equal(h.tool.name, "background_task");
		assert.equal(h.tool.exposure, "model-only");
		assert.match(h.tool.description, /return task IDs immediately/);
		assert.ok(h.tool.description.length < 500);
		assert.equal(h.tool.promptGuidelines, undefined);
		assert.ok(h.tool.outputSchema);
		assert.equal(h.tool.annotations.readOnlyHint, false);
		assert.equal(h.tool.annotations.destructiveHint, true);
		assert.equal(h.clock.timers.size, 0);
		assert.equal(h.calls.length, 0);
		assert.equal((await h.tool.execute("early", { action: "list" })).isError, true);
	} finally { await h.close(); }
});

test("start provides non-blocking next steps in both model text and structured results", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		const started = await h.tool.execute("start", { action: "start", command: "sleep 60" });
		const { task, guidance } = started.structuredContent;
		assert.equal(task.status, "running");
		assert.equal(guidance, "Notifies automatically on completion. Do not sleep or poll; continue other work or end the turn.");
		assert.ok(started.content[0].text.includes(guidance), "the start result must include the guidance");
		assert.ok(h.tool.description.includes(guidance), "the tool description must include the same guidance");
		assert.equal(h.tool.outputSchema.properties.guidance.type, "string");
		assert.equal(h.tool.outputSchema.required?.includes("guidance") ?? false, false);
		const list = await h.tool.execute("list", { action: "list" });
		const output = await h.tool.execute("output", { action: "output", id: task.id });
		assert.equal(list.structuredContent.guidance, undefined);
		assert.equal(output.structuredContent.guidance, undefined);
		h.calls[0].resolve();
		await flush();
		h.clock.advance(0);
		assert.equal(h.messages.filter((entry) => entry.message.customType === "background-task-finished").length, 1);
	} finally { await h.close(); }
});

test("tools, commands, widget and idle notifications share the same session jobs", async () => {
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
		h.clock.advance(0);
		const completed = h.messages.filter((m) => m.message.customType === "background-task-finished");
		assert.equal(completed.length, 1);
		assert.deepEqual(completed[0].options, { triggerTurn: true, deliverAs: "steer" });
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
		h.clock.advance(0);
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
			h.clock.advance(0);
			assert.equal(h.clock.timers.size, 0);
			assert.equal(h.statuses.has("background-tasks"), false);
			assert.equal(h.messages.at(-1).options.deliverAs, "steer");
		} finally { await h.close(); }
	});
}

test("bad actions, irrelevant fields, aborted acceptance and command syntax fail visibly", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		for (const params of [
			{ action: "other" }, { action: "notifications", enabled: false }, { action: "start" }, { action: "list", command: "ignored" },
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

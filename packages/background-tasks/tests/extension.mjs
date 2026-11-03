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
	let tool, renders = 0, idle = true, failSend = false;
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
		sendMessage(message, options) {
			if (failSend) { failSend = false; throw new Error("Fixture delivery rejected"); }
			messages.push({ message, options });
		},
	};
	register(pi, { operations: f.operations, clock: f.clock, logRoot: f.root, env: {} });
	return {
		...f, handlers, commands, messages, notices, widgets, placements, statuses, idleChecks, ctx,
		setIdle(value) { idle = value; },
		failNextSend() { failSend = true; },
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

test("completion sends only status and log location with progressive-inspection guidance", async () => {
	const h = harness("print", false);
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		h.setIdle(false);
		const task = (await h.tool.execute("start", { action: "start", command: "build" })).structuredContent.task;
		h.calls[0].onData(Buffer.from("BUILD RESULT: done\n"));
		h.calls[0].resolve();
		await flush();
		const message = h.handlers.get("turn_end")({ entries: [], outcome: "completed" }, h.ctx).entries[0];
		assert.doesNotMatch(message.content, /BUILD RESULT: done|Untrusted shell output/);
		assert.ok(message.content.includes(`Captured log: ${task.log_path}`));
		assert.match(message.content, /Inspect logs progressively as needed/);
		assert.match(message.content, /search for relevant terms or read bounded ranges/);
		assert.doesNotMatch(message.content, /do not repeatedly|Do not sleep|Inspect:/);
		const inspected = await h.tool.execute("inspect", { action: "output", id: task.id });
		assert.equal(inspected.structuredContent.output, "BUILD RESULT: done\n");
		assert.equal(h.handlers.get("agent_before_settle")({ entries: [], outcome: "completed" }, h.ctx), undefined);
	} finally { await h.close(); }
});

test("status-only completion batches stay bounded without reading or injecting large UTF-8 logs", async () => {
	const h = harness("print", false);
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		h.setIdle(false);
		const ids = [];
		const data = Buffer.from("🙂".repeat(3000));
		for (let i = 0; i < 10; i++) {
			const task = (await h.tool.execute(`start-${i}`, { action: "start", command: `build-${i}`, description: "界".repeat(200) })).structuredContent.task;
			ids.push(task.id);
			h.calls[i].onData(data);
			h.calls[i].reject(new Error("错".repeat(500)));
			await flush();
		}
		const delivered = [];
		let batches = 0;
		for (;;) {
			const boundary = h.handlers.get("turn_end")({ entries: [], outcome: "completed" }, h.ctx);
			if (!boundary) break;
			assert.ok(++batches <= ids.length, "every batch must make progress");
			const message = boundary.entries[0];
			assert.ok(Buffer.byteLength(message.content) <= 16384);
			assert.ok(!message.content.includes("\uFFFD"), "budget cuts must preserve UTF-8");
			assert.ok(!message.content.includes("🙂"), "captured log bodies must not enter notifications");
			assert.doesNotMatch(message.content, /Untrusted shell output|Output preview/);
			delivered.push(...message.details.tasks.map((task) => task.id));
		}
		assert.ok(batches > 1, "long metadata must split the pending batch");
		assert.deepEqual(delivered, ids);
		assert.equal(h.messages.length, 0);
		const inspected = await h.tool.execute("inspect", { action: "output", id: ids[0] });
		assert.equal(inspected.structuredContent.task.bytes, data.length);
		assert.equal(inspected.structuredContent.task.capture_complete, true);
	} finally { await h.close(); }
});

test("notification does not open missing logs; later explicit inspections report errors independently", async () => {
	const h = harness("print", false);
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		h.setIdle(false);
		const broken = (await h.tool.execute("broken", { action: "start", command: "broken" })).structuredContent.task;
		const healthy = (await h.tool.execute("healthy", { action: "start", command: "healthy" })).structuredContent.task;
		h.calls[0].onData(Buffer.from("unavailable log\n"));
		h.calls[1].onData(Buffer.from("healthy result\n"));
		h.calls[0].resolve(7);
		h.calls[1].resolve();
		await flush();
		unlinkSync(broken.log_path);
		const message = h.handlers.get("turn_end")({ entries: [], outcome: "completed" }, h.ctx).entries[0];
		assert.deepEqual(message.details.tasks.map((task) => task.id), [broken.id, healthy.id]);
		assert.equal(message.details.tasks[0].status, "failed");
		assert.equal(message.details.tasks[0].capture_complete, true, "notification must not inspect the file or mutate capture state");
		assert.ok(message.content.includes(broken.log_path));
		assert.ok(message.content.includes(healthy.log_path));
		assert.doesNotMatch(message.content, /healthy result|unavailable log|Output unavailable/);
		const missing = await h.tool.execute("read-broken", { action: "output", id: broken.id });
		assert.equal(missing.isError, true);
		assert.match(missing.structuredContent.error, /Cannot read task log/);
		const present = await h.tool.execute("read-healthy", { action: "output", id: healthy.id });
		assert.equal(present.structuredContent.output, "healthy result\n");
		assert.equal(h.handlers.get("agent_before_settle")({ entries: [], outcome: "completed" }, h.ctx), undefined);
	} finally { await h.close(); }
});

test("a rejected idle delivery retains its result for the next safe boundary", async () => {
	const h = harness("print", false);
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		const task = (await h.tool.execute("start", { action: "start", command: "build" })).structuredContent.task;
		h.calls[0].onData(Buffer.from("retained result\n"));
		h.calls[0].resolve();
		await flush();
		h.failNextSend();
		h.clock.advance(0);
		assert.equal(h.messages.length, 0);
		const message = h.handlers.get("turn_end")({ entries: [], outcome: "completed" }, h.ctx).entries[0];
		assert.equal(message.details.tasks[0].id, task.id);
		assert.ok(message.content.includes(task.log_path));
		assert.doesNotMatch(message.content, /retained result/);
		assert.equal((await h.tool.execute("inspect", { action: "output", id: task.id })).structuredContent.output, "retained result\n");
		assert.equal(h.handlers.get("agent_before_settle")({ entries: [], outcome: "completed" }, h.ctx), undefined);
	} finally { await h.close(); }
});

test("timeout and empty-result notifications contain status and paths, not captured output", async () => {
	const h = harness("print", false);
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		h.setIdle(false);
		await h.tool.execute("slow", { action: "start", command: "slow", timeout: 1 });
		h.calls[0].onData(Buffer.from("partial before deadline\n"));
		h.clock.advance(1000);
		h.calls[0].reject(new Error("aborted"));
		await flush();
		const timedOut = h.handlers.get("turn_end")({ entries: [], outcome: "completed" }, h.ctx).entries[0];
		assert.equal(timedOut.details.tasks[0].status, "timed_out");
		assert.match(timedOut.content, /Runtime limit of 1 seconds reached/);
		assert.doesNotMatch(timedOut.content, /partial before deadline/);
		assert.ok(timedOut.content.includes(timedOut.details.tasks[0].log_path));
		assert.equal((await h.tool.execute("read-slow", { action: "output", id: timedOut.details.tasks[0].id })).structuredContent.output, "partial before deadline\n");
		await h.tool.execute("empty", { action: "start", command: "empty" });
		h.calls[1].resolve();
		await flush();
		const empty = h.handlers.get("turn_end")({ entries: [], outcome: "completed" }, h.ctx).entries[0];
		assert.ok(empty.content.includes(empty.details.tasks[0].log_path));
		assert.doesNotMatch(empty.content, /\(no output\)/);
		assert.equal((await h.tool.execute("read-empty", { action: "output", id: empty.details.tasks[0].id })).structuredContent.output, "");
		assert.doesNotMatch(empty.content, /For logs:|For more logs:/);
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
		assert.match(h.tool.description, /up to two concurrent background shell tasks/);
		assert.match(h.tool.parameters.properties.action.description, /start returns a task ID immediately/);
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

test("start keeps only task-specific guidance while the declaration describes lifecycle and running queries", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")({}, h.ctx);
		const started = await h.tool.execute("start", { action: "start", command: "sleep 60" });
		const { task } = started.structuredContent;
		const notice = "Completion is reported automatically. Continue other work or end the turn; do not repeatedly query just to wait for completion.";
		assert.equal(task.status, "running");
		assert.ok(started.content[0].text.includes(notice));
		assert.ok(!started.content[0].text.includes(task.log_path));
		assert.ok(!started.content[0].text.includes("session changes"));
		assert.ok(!h.tool.description.includes(notice), "declaration must not duplicate the whole start reminder");
		assert.match(h.tool.description, /automatic completion notifications/);
		assert.match(h.tool.description, /session changes, reload, or exit/);
		assert.match(h.tool.parameters.properties.action.description, /list and output also work while tasks are running/);
		assert.equal(started.structuredContent.guidance, undefined);
		assert.equal(h.tool.outputSchema.properties.guidance, undefined);
		const list = await h.tool.execute("list", { action: "list" });
		const output = await h.tool.execute("output", { action: "output", id: task.id });
		assert.equal(list.structuredContent.tasks[0].status, "running", "status inspection does not require a completion notification");
		assert.equal(output.structuredContent.task.status, "running", "log inspection is allowed before completion");
		assert.equal(h.messages.length, 0, "running-task inspection does not wait for or create a notification");
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

		h.calls[0].onData(Buffer.from("captured build output\n"));
		await h.commands.get("bg").handler(`output ${job.id}`, h.ctx);
		assert.match(h.messages.at(-1).message.content, /captured build output/);
		assert.equal(h.messages.at(-1).options.triggerTurn, false);
		const output = await h.tool.execute("output", { action: "output", id: job.id });
		assert.equal(output.structuredContent.output, "captured build output\n");
		assert.equal(output.details.output, undefined);

		h.calls[0].resolve(7);
		await flush();
		h.clock.advance(0);
		const completed = h.messages.filter((m) => m.message.customType === "background-task-finished");
		assert.equal(completed.length, 1);
		assert.deepEqual(completed[0].options, { triggerTurn: true, deliverAs: "steer" });
		assert.match(completed[0].message.content, /failed.*exit 7/);
		assert.doesNotMatch(completed[0].message.content, /captured build output/);
		assert.ok(!completed[0].message.content.includes(`background_task({action:"output",id:"${job.id}"})`), "complete small output needs no follow-up query");
		assert.ok(completed[0].message.content.includes(job.log_path), "completion points at the log for progressive inspection");
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

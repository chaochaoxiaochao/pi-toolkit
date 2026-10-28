import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import register from "../extensions/background-tasks.ts";
import { HerdrError } from "../src/herdr.ts";
import { VIEW_SCRIPT } from "../src/viewer.ts";
import { fixture, flush } from "./helpers.mjs";

/** In-memory Herdr: records CLI calls and models tabs, panes and focus. */
function fakeHerdr() {
	const calls = [];
	const tabs = new Map();
	const panes = new Map();
	let next = 0;
	const state = { focused: false, fail: undefined };
	const missing = (kind, id) => new HerdrError(`${kind} ${id} not found`, `${kind}_not_found`);
	const call = async (args) => {
		calls.push(args);
		if (state.fail?.(args)) throw new Error(`herdr ${args.join(" ")} failed`);
		const [noun, verb, id] = args;
		if (noun === "tab" && verb === "create") {
			const tab = `w:t${++next}`, pane = `w:p${++next}`;
			tabs.set(tab, true);
			panes.set(pane, { tab, runs: [] });
			return { tab: { tab_id: tab }, root_pane: { pane_id: pane } };
		}
		if (noun === "tab") {
			if (!tabs.has(id)) throw missing("tab", id);
			if (verb === "close") {
				tabs.delete(id);
				for (const [pane, value] of panes) if (value.tab === id) panes.delete(pane);
			}
			return { tab: { tab_id: id, focused: state.focused } };
		}
		if (!panes.has(id)) throw missing("pane", id);
		if (verb === "split") {
			const pane = `w:p${++next}`;
			panes.set(pane, { tab: panes.get(id).tab, runs: [] });
			return { pane: { pane_id: pane } };
		}
		if (verb === "run") panes.get(id).runs.push(args[3]);
		return { pane: { pane_id: id } };
	};
	return { call, calls, tabs, panes, state, closePane: (id) => panes.delete(id) };
}

function harness(env = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w" }) {
	const f = fixture();
	const herdr = fakeHerdr();
	const handlers = new Map();
	const commands = new Map();
	const notices = [];
	const widgets = new Map();
	let tool;
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const ctx = {
		cwd: f.root, mode: "tui", hasUI: true, isIdle: () => true,
		ui: {
			setWidget(key, factory) { if (factory) widgets.set(key, factory({ requestRender() {} }, theme)); else widgets.delete(key); },
			setStatus() {}, notify(message, level) { notices.push({ message, level }); },
		},
	};
	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerTool(value) { tool = value; },
		registerCommand(name, value) { commands.set(name, value); },
		sendMessage() {},
	};
	register(pi, { operations: f.operations, clock: f.clock, logRoot: f.root, herdr: herdr.call, env, sleep: () => flush() });
	return {
		...f, herdr, handlers, commands, notices, widgets, ctx,
		start: async (command) => (await tool.execute(command, { action: "start", command })).structuredContent.task,
		begin: () => handlers.get("session_start")({}, ctx),
		async close() {
			const closing = handlers.get("session_shutdown")({}, ctx);
			for (const call of f.calls) call.resolve();
			await closing;
			await f.close();
		},
	};
}

async function settle() { for (let i = 0; i < 20; i++) await flush(); }

test("two tasks share one unfocused tab, one pane each; the pane shows the command, then the log", async () => {
	const h = harness();
	try {
		await h.begin();
		const first = await h.start("printf 'a\\n'; sleep 1");
		const second = await h.start("make test");
		await settle();
		assert.equal(h.herdr.tabs.size, 1);
		assert.equal(h.herdr.panes.size, 2);
		const create = h.herdr.calls.find((args) => args[0] === "tab" && args[1] === "create");
		assert.ok(create.includes("--no-focus"));
		assert.ok(h.herdr.calls.filter((args) => args[1] === "split").every((args) => args.includes("--no-focus")));
		const runs = [...h.herdr.panes.values()].map((pane) => pane.runs.at(-1));
		assert.ok(runs[0].includes(first.log_path) && runs[1].includes(second.log_path));
		assert.doesNotMatch(runs.join("\n"), /make test|printf/, "the command text is never passed as shell syntax");
		assert.match(readFileSync(first.log_path.replace(/\.log$/, ".header"), "utf8"), /^\$ printf 'a\\n'; sleep 1\n# bg-.* · cwd .* · timeout 30m\n/);
	} finally { await h.close(); }
});

test("a finished task's pane shows the result, is reused, and the tab closes once nothing runs", async () => {
	const h = harness();
	try {
		await h.begin();
		const first = await h.start("one");
		await h.start("two");
		await settle();
		h.calls[0].resolve(3);
		await settle();
		assert.match(readFileSync(first.log_path.replace(/\.log$/, ".done"), "utf8"), /\[failed · exit 3 · 0s\]/);
		assert.equal(h.herdr.tabs.size, 1, "the tab stays while a task still runs");
		const third = await h.start("three");
		await settle();
		assert.equal(h.herdr.panes.size, 2, "the finished task's pane is reused");
		assert.ok([...h.herdr.panes.values()].some((pane) => pane.runs.at(-1).includes(third.log_path)));
		h.calls[1].resolve();
		h.calls[2].resolve();
		await settle();
		assert.equal(h.herdr.tabs.size, 0);
	} finally { await h.close(); }
});

test("the tab waits while the user looks at it, then closes after focus moves away", async () => {
	const h = harness();
	try {
		await h.begin();
		await h.start("one");
		await settle();
		h.herdr.state.focused = true;
		h.calls[0].resolve();
		await settle();
		assert.equal(h.herdr.tabs.size, 1);
		h.herdr.state.focused = false;
		await settle();
		assert.equal(h.herdr.tabs.size, 0);
	} finally { await h.close(); }
});

test("closing a pane keeps the task running; /bg watch reopens and focuses it", async () => {
	const h = harness();
	try {
		await h.begin();
		const task = await h.start("one");
		await settle();
		h.herdr.closePane([...h.herdr.panes.keys()][0]);
		assert.equal(h.calls[0].signal.aborted, false);
		await h.commands.get("bg").handler(`watch ${task.id}`, h.ctx);
		await settle();
		assert.equal(h.herdr.tabs.size, 1);
		assert.equal(h.herdr.panes.size, 1);
		assert.ok([...h.herdr.panes.values()][0].runs.at(-1).includes(task.log_path));
		assert.ok(h.herdr.calls.some((args) => args[0] === "tab" && args[1] === "focus"));
		assert.deepEqual(h.notices, []);
	} finally { await h.close(); }
});

test("clicking a widget task row opens its view and focuses the tab; other clicks do nothing", async () => {
	const h = harness();
	try {
		await h.begin();
		await h.start("one");
		const second = await h.start("two");
		await settle();
		h.herdr.closePane([...h.herdr.panes.keys()][1]);
		const widget = h.widgets.get("background-tasks");
		const lines = widget.render(120);
		assert.match(lines[2], new RegExp(second.id));
		const click = (y, extra = {}) => widget.handleMouse({ type: "click", button: "left", x: 4, y, screenX: 4, screenY: y, width: 120, height: lines.length, shift: false, alt: false, ctrl: false, ...extra });
		assert.equal(click(0), undefined, "the title row is not a task");
		assert.equal(click(2, { button: "right" }), undefined);
		const before = h.herdr.calls.length;
		assert.deepEqual(click(2), { handled: true, render: false });
		await settle();
		assert.ok(h.herdr.calls.length > before);
		assert.ok([...h.herdr.panes.values()].some((pane) => pane.runs.at(-1).includes(second.log_path)), "the closed pane was reopened");
		const [first] = h.herdr.panes.keys();
		assert.deepEqual(h.herdr.calls.at(-2).slice(0, 2), ["tab", "focus"]);
		assert.deepEqual(h.herdr.calls.at(-1), ["pane", "focus", "--pane", first, "--direction", "right"], "the reopened right pane gets focus");
		click(1);
		await settle();
		const [, right] = h.herdr.panes.keys();
		assert.deepEqual(h.herdr.calls.at(-1), ["pane", "focus", "--pane", right, "--direction", "left"], "the left pane gets focus");
	} finally { await h.close(); }
});

test("Herdr failures warn once and never affect tasks", async () => {
	const h = harness();
	try {
		await h.begin();
		h.herdr.state.fail = () => true;
		await h.start("one");
		await h.start("two");
		await settle();
		assert.equal(h.notices.length, 1);
		assert.equal(h.notices[0].level, "warning");
		assert.ok(h.calls.every((call) => !call.signal.aborted), "tasks keep running");
		h.calls[0].resolve();
		h.calls[1].resolve();
		await settle();
		assert.equal(h.notices.length, 1, "the warning is shown once");
	} finally { await h.close(); }
});

test("session shutdown closes the tab immediately", async () => {
	const h = harness();
	await h.begin();
	await h.start("one");
	await settle();
	h.herdr.state.focused = true;
	await h.close();
	assert.equal(h.herdr.tabs.size, 0);
});

for (const [label, env] of [
	["outside Herdr", {}],
	["in a Herdr subagent child", { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w", PI_HERDR_SUBAGENTS_CHILD: "1" }],
]) {
	test(`${label}, no Herdr call is made and /bg watch explains why`, async () => {
		const h = harness(env);
		try {
			await h.begin();
			const task = await h.start("one");
			await settle();
			await h.commands.get("bg").handler(`watch ${task.id}`, h.ctx);
			const widget = h.widgets.get("background-tasks");
			widget.render(120);
			assert.equal(widget.handleMouse({ type: "click", button: "left", x: 4, y: 1, width: 120, height: 2 }), undefined, "rows are not clickable without a view");
			assert.deepEqual(h.herdr.calls, []);
			assert.match(h.notices[0].message, /inside Herdr/);
		} finally { await h.close(); }
	});
}

test("the view script follows a real log, then prints the result line", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-bg-view-"));
	try {
		const [log, done, header, script] = ["t.log", "t.done", "t.header", "view.sh"].map((name) => join(dir, name));
		writeFileSync(log, "line 1\nline 2\n");
		writeFileSync(header, "$ echo hi\n");
		writeFileSync(script, VIEW_SCRIPT);
		setTimeout(() => writeFileSync(done, "\n[succeeded · exit 0 · 1s]\n"), 300);
		const { stdout: output } = await promisify(execFile)("sh", [script, log, done, header], { encoding: "utf8", timeout: 10000 });
		assert.match(output, /\$ echo hi\nline 1\nline 2\n\n\[succeeded · exit 0 · 1s\]\n$/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import registerTodo from "../extensions/todo.ts";

const theme = {
	fg(_color, text) { return text; },
	bold(text) { return text; },
};

function createHarness(branch = [], hasUI = true) {
	const handlers = new Map();
	const commands = new Map();
	let tool;
	let currentBranch = branch;
	let widget;
	let historyComponent;
	let renderRequests = 0;
	const tui = { requestRender() { renderRequests += 1; } };
	const ui = {
		setWidget(_key, value) {
			if (value === undefined) {
				widget = undefined;
				return;
			}
			widget = value(tui, theme);
		},
		notify() {},
		async custom(factory) {
			historyComponent = factory(tui, theme, {}, () => {});
		},
	};
	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerTool(definition) { tool = definition; },
		registerCommand(name, definition) { commands.set(name, definition); },
	};
	const childGuard = process.env.PI_HERDR_SUBAGENTS_CHILD;
	delete process.env.PI_HERDR_SUBAGENTS_CHILD;
	try {
		registerTodo(pi);
	} finally {
		if (childGuard === undefined) delete process.env.PI_HERDR_SUBAGENTS_CHILD;
		else process.env.PI_HERDR_SUBAGENTS_CHILD = childGuard;
	}
	const context = {
		hasUI,
		mode: hasUI ? "tui" : "print",
		ui,
		sessionManager: { getBranch: () => currentBranch },
	};
	return {
		handlers,
		commands,
		context,
		get tool() { return tool; },
		get widget() { return widget; },
		get historyComponent() { return historyComponent; },
		get renderRequests() { return renderRequests; },
		setBranch(value) { currentBranch = value; },
	};
}

function toolResult(todos, nextId) {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo",
			details: { action: "list", todos, nextId },
		},
	};
}

const branch = [toolResult([
	{ id: 1, text: "Closed history", status: "done" },
	{ id: 2, text: "Current work", status: "doing" },
	{ id: 3, text: "Later work", status: "todo" },
], 4)];
const harness = createHarness(branch);
await harness.handlers.get("session_start")({}, harness.context);
assert.ok(harness.tool, "Todo tool is registered");
assert.deepEqual(harness.tool.parameters.properties.action.enum, ["plan", "add_step", "complete_current", "cancel_current", "list"]);
assert.equal(harness.renderRequests, 1, "mounting the widget explicitly requests a TUI render");
const mountedWidget = harness.widget;
const initialWidget = mountedWidget.render(100).join("\n");
assert.match(initialWidget, /1\. Current work/);
assert.match(initialWidget, /2\. Later work/);
assert.doesNotMatch(initialWidget, /#2|#3|Closed history|done|cancelled/, "widget hides IDs and closed history");

const completed = await harness.tool.execute("complete", {
	action: "complete_current",
	expected_current_id: 2,
}, undefined, undefined, harness.context);
assert.equal(harness.widget, mountedWidget, "live updates keep the mounted widget component");
assert.ok(harness.renderRequests >= 2, "state change invalidates the widget and requests another render");
const updatedWidget = mountedWidget.render(100).join("\n");
assert.match(updatedWidget, /1\. Later work/);
assert.doesNotMatch(updatedWidget, /Current work/, "mounted widget reads current state instead of a captured row snapshot");
assert.equal(completed.content[0].text, "CURRENT plan\n#3 [doing] Later work");

await harness.commands.get("todos").handler("", harness.context);
const history = harness.historyComponent.render(100).join("\n");
assert.match(history, /#1 Closed history/);
assert.match(history, /#2 Current work/);
assert.match(history, /#3 Later work/, "/todos alone exposes complete branch history");

await harness.tool.execute("empty", { action: "plan", items: [] }, undefined, undefined, harness.context);
assert.equal(harness.widget, undefined, "widget disappears when the current plan is done or cancelled");
assert.ok(harness.renderRequests >= 3, "unmounting the widget requests a render");

harness.setBranch([toolResult([
	{ id: 10, text: "Selected branch only", status: "doing" },
	{ id: 11, text: "Selected branch next", status: "todo" },
], 12)]);
await harness.handlers.get("session_tree")({}, harness.context);
const branchList = await harness.tool.execute("branch-list", { action: "list" }, undefined, undefined, harness.context);
assert.equal(branchList.content[0].text, "CURRENT plan\n#10 [doing] Selected branch only\n#11 [todo] Selected branch next");
assert.doesNotMatch(branchList.content[0].text, /Closed history|Later work/, "tree navigation reconstructs only getBranch snapshots");

const serialized = createHarness([], false);
await serialized.handlers.get("session_start")({}, serialized.context);
const [planned, firstCompletion, repeatedCompletion] = await Promise.all([
	serialized.tool.execute("plan", { action: "plan", items: ["First", "Second", "Third"] }, undefined, undefined, serialized.context),
	serialized.tool.execute("complete-one", { action: "complete_current", expected_current_id: 1 }, undefined, undefined, serialized.context),
	serialized.tool.execute("complete-repeat", { action: "complete_current", expected_current_id: 1 }, undefined, undefined, serialized.context),
]);
assert.equal(planned.content[0].text, "CURRENT plan\n#1 [doing] First\n#2 [todo] Second\n#3 [todo] Third");
assert.equal(firstCompletion.content[0].text, "CURRENT plan\n#2 [doing] Second\n#3 [todo] Third");
assert.equal(repeatedCompletion.isError, true, "same-turn repeated completion fails after the first queued call advances");
assert.match(repeatedCompletion.content[0].text, /expected current #1, but current is #2/);
assert.match(repeatedCompletion.content[0].text, /#2 \[doing\] Second/);
const afterConcurrentCalls = await serialized.tool.execute("list", { action: "list" }, undefined, undefined, serialized.context);
assert.equal(afterConcurrentCalls.content[0].text, "CURRENT plan\n#2 [doing] Second\n#3 [todo] Third");

console.log("Todo extension integration tests passed");

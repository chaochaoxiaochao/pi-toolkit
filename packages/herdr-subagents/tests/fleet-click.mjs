import assert from "node:assert/strict";
import { FleetController } from "../src/fleet-controller.ts";

// A real FleetWidget through the controller; no session watchers or timers fire.
const runtime = {
	watchSession: () => ({ close() {} }),
	setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
	readTokens: async () => undefined,
};
const focused = [];
const herdr = { async focusPane(paneId) { focused.push(paneId); if (paneId === "gone") throw new Error("pane_not_found"); } };
let widget;
const ui = {
	setWidget(_key, factory) { widget = factory ? factory({ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }) : undefined; },
	onTerminalInput: () => () => {},
	getEditorText: () => "",
};
const controller = new FleetController(herdr, () => true, undefined, runtime);
controller.bind(ui, true);
const batch = {
	runId: "r1", label: "review", status: "running", prompts: [], tasks: [], documents: [], summary: "", ok: false,
	requestedConcurrency: 3, effectiveConcurrency: 3, recordDirectory: "/tmp/fleet-click",
	activity: [
		{ index: 0, name: "first", agent: "reviewer", status: "running", paneId: "p1" },
		{ index: 1, name: "queued", agent: "reviewer", status: "queued" },
		{ index: 2, name: "third", agent: "reviewer", status: "completed", paneId: "gone" },
	],
};
controller.setActive(batch);
const lines = widget.render(100);
assert.match(lines[1], /first/);
const click = (y, extra = {}) => widget.handleMouse({ type: "click", button: "left", x: 3, y, screenX: 3, screenY: y, width: 100, height: lines.length, shift: false, alt: false, ctrl: false, ...extra });

assert.equal(click(0), undefined, "the title row is not a task");
assert.equal(click(1, { button: "right" }), undefined, "only primary clicks select");
assert.equal(click(1, { type: "press" }), undefined, "press without release does not select");
assert.equal(click(4), undefined, "rows below the tasks are ignored");
assert.deepEqual(click(1), { handled: true, render: false });
assert.deepEqual(focused, ["p1"], "a click focuses that task's Herdr pane");
assert.deepEqual(click(2), { handled: true, render: false }, "a queued row is a task row");
assert.deepEqual(focused, ["p1"], "a task without a pane focuses nothing");
click(3);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(focused, ["p1", "gone"], "a vanished pane fails quietly");

// A pending update must not change the meaning of the row still on screen.
controller.setActive({ ...batch, activity: [...batch.activity].reverse() });
click(1);
assert.equal(focused.at(-1), "p1", "click uses the last rendered row, not an unpainted update");
widget.render(100);
click(3);
assert.equal(focused.at(-1), "p1", "after repaint, the same task has moved to row 3");
widget.dispose();
assert.equal(click(1), undefined, "disposed widgets ignore clicks");

controller.clearRun("r1");
assert.equal(widget, undefined);
console.log("PASS Fleet widget row clicks focus the matching subagent pane");

// Retained Fleet regressions from the former lifecycle monolith.
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { aggregateSessionTokens, fleetEditorHasFocus, FleetSelection, fleetLines, formatFleetDuration, formatFleetTokens } from "../src/fleet.ts";
import { FleetController, FleetWidget } from "../src/fleet-controller.ts";
import { applyTaskStatus, projectTaskActivity } from "../src/records.ts";

function check(name, condition) {
	assert.ok(condition, name);
	console.log(`PASS ${name}`);
}

const fleet = new FleetSelection();
const fleetBatch = { label: "reviews", activity: [
	{ index: 0, name: "one", status: "completed", paneId: "p1" },
	{ index: 1, name: "two", status: "running", paneId: "p2" },
] };
check("Fleet selection activates only from an empty editor", !fleet.handle("\u001b[B", "draft", 2).consume && fleet.handle("\u001b[B", "", 2).consume && fleet.isSelecting());
check("Fleet arrows move and Enter selects the exact row", fleet.handle("\u001b[B", "", 2).consume && fleet.handle("\r", "", 2).focusTask === 2 && fleetLines(fleetBatch, fleet)[2].startsWith("›"));
check("Fleet unrelated input exits without consuming it", fleet.handle("x", "", 2).consume !== true && !fleet.isSelecting());
check("Fleet Escape exits selection", fleet.handle("\u001b[B", "", 2).consume && fleet.handle("\u001b", "", 2).consume && !fleet.isSelecting());
const enhancedFleet = new FleetSelection((data, key) => data === `enhanced-${key}`);
check("Fleet delegates enhanced keyboard decoding to Pi key matching", enhancedFleet.handle("enhanced-down", "", 2).consume && enhancedFleet.handle("enhanced-up", "", 2).consume && enhancedFleet.handle("enhanced-enter", "", 2).focusTask === 2);
const shrinkingFleet = new FleetSelection();
shrinkingFleet.handle("\u001b[B", "", 3);
shrinkingFleet.handle("\u001b[A", "", 3);
check("Fleet Enter focuses the row displayed after activity shrinks", shrinkingFleet.selectedIndex(2) === 1 && shrinkingFleet.handle("\r", "", 2).focusTask === 2);
check("Fleet ignores unknown focus, dialogs, and overlays", fleetEditorHasFocus(undefined, () => false) === false && fleetEditorHasFocus({ kind: "dialog" }, () => false) === false && fleetEditorHasFocus({ kind: "editor" }, () => true) === true);
const usage = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const usageJsonl = [
	{ type: "message", message: { role: "assistant", usage: usage(1, 2, 3, 4) } },
	{ type: "usage", usage: usage(5, 6, 7, 8) },
	{ type: "message", message: { role: "toolResult", usage: usage(9, 10, 11, 12) } },
	{ type: "compaction", usage: usage(1, 1, 1, 1) },
	{ type: "branch_summary", usage: usage(2, 2, 2, 2) },
	{ type: "message", message: { role: "user", usage: usage(99, 99, 99, 99) } },
].map(JSON.stringify).join("\n");
check("Fleet aggregates every authoritative Pi usage-bearing entry", aggregateSessionTokens(usageJsonl) === 90);
check("Fleet ignores malformed and truncated JSONL while preserving valid usage", aggregateSessionTokens(`${usageJsonl.split("\n")[0]}\nnot-json\n{\"type\":\"message\",\"message\":`) === 10);
const elapsedStart = "2026-10-08T07:00:00.000Z";
check("Fleet elapsed formatting is live and blocked duration freezes", formatFleetDuration({ index: 0, name: "live", agent: "explorer", status: "running", startedAt: elapsedStart }, Date.parse(elapsedStart) + 65_000) === "1m 5s" && formatFleetDuration({ index: 0, name: "blocked", agent: "explorer", status: "blocked", startedAt: elapsedStart, updatedAt: "2026-10-08T07:00:05.000Z" }, Date.parse(elapsedStart) + 99_000) === "5s");
const timedTask = { id: "timed", runId: "run", order: 1, name: "timed", agent: "worker", status: "queued" };
applyTaskStatus(timedTask, "running", { at: elapsedStart });
applyTaskStatus(timedTask, "blocked", { at: "2026-10-08T07:00:05.000Z" });
applyTaskStatus(timedTask, "running", { at: "2026-10-08T07:01:00.000Z" });
check("Fleet duration accumulates active work without counting blocked wait", formatFleetDuration(projectTaskActivity(timedTask), Date.parse("2026-10-08T07:01:07.000Z")) === "12s");
const legacyTimedTask = { id: "legacy", runId: "run", order: 1, name: "legacy", agent: "worker", status: "blocked", startedAt: elapsedStart, updatedAt: "2026-10-08T07:00:05.000Z" };
applyTaskStatus(legacyTimedTask, "running", { at: "2026-10-08T07:01:00.000Z" });
check("Fleet timing migrates legacy blocked records without losing prior work", formatFleetDuration(projectTaskActivity(legacyTimedTask), Date.parse("2026-10-08T07:01:07.000Z")) === "12s");
const recoveredTimedTask = { id: "recovered", runId: "run", order: 1, name: "recovered", agent: "worker", status: "running", startedAt: elapsedStart };
applyTaskStatus(recoveredTimedTask, "cancelled", { at: "2026-10-08T07:00:09.000Z" });
check("Fleet timing settles legacy recovered-running records", formatFleetDuration(projectTaskActivity(recoveredTimedTask), Date.parse("2026-10-08T08:00:00.000Z")) === "9s");
check("Fleet formats true token totals without estimates", formatFleetTokens(999) === "999 tok" && formatFleetTokens(1_250) === "1.3k tok" && formatFleetTokens(12_400) === "12k tok");
const metricFleet = new FleetSelection();
const metricBatch = { label: "audit", activity: [
	{ index: 0, name: "inspect auth", agent: "explorer", status: "running", startedAt: elapsedStart, sessionFile: "/tmp/live.jsonl" },
	{ index: 1, name: "review patch", agent: "reviewer", status: "queued", sessionFile: "/tmp/queued.jsonl" },
] };
const metricLines = fleetLines(metricBatch, metricFleet, { width: 80, now: Date.parse(elapsedStart) + 65_000, metrics: new Map([[0, { tokens: 1_250 }], [1, { tokens: 999 }]]) });
check("Fleet rows show persona task status elapsed and right-aligned true usage", metricLines[1].includes("explorer") && metricLines[1].includes("inspect auth") && metricLines[1].includes("running") && metricLines[1].endsWith("1m 5s  1.3k tok"));
const compactLines = fleetLines({ label: "compact", activity: [
	{ index: 0, name: "API", agent: "explorer", status: "running", startedAt: elapsedStart },
	{ index: 1, name: "Recovery", agent: "explorer", status: "completed", startedAt: elapsedStart, completedAt: "2026-10-08T07:00:09.000Z" },
] }, new FleetSelection(), { width: 160, now: Date.parse(elapsedStart) + 21_000, metrics: new Map([[0, { tokens: 4_800 }], [1, { tokens: 900 }]]) });
check("wide Fleet rows align metrics without terminal-width whitespace", visibleWidth(compactLines[1]) < 80 && compactLines[1].indexOf("tok") === compactLines[2].indexOf("tok"));
const semanticColors = [];
fleetLines({ label: "colors", activity: [
	{ index: 0, name: "doing", agent: "worker", status: "running" },
	{ index: 1, name: "done", agent: "worker", status: "completed" },
] }, new FleetSelection(), { theme: { fg: (color, text) => { semanticColors.push([color, text]); return text; }, bold: (text) => text } });
check("Fleet uses warning yellow for running work and success green for completed work", semanticColors.some(([color, text]) => color === "warning" && text === "●") && semanticColors.some(([color, text]) => color === "success" && text === "●"));
check("queued Fleet rows fabricate neither duration nor usage", metricLines[2].includes("reviewer") && metricLines[2].includes("queued") && !metricLines[2].includes("tok") && !metricLines[2].match(/\d+[smh]/));
check("Fleet rendering fits narrow terminal widths", [1, 8, 16, 24].every((width) => fleetLines(metricBatch, metricFleet, { width, metrics: new Map([[0, { tokens: 1_250 }]]) }).every((line) => visibleWidth(line) <= width)));
let liveTokens = 42;
let nextRuntimeId = 1;
const runtimeIntervals = new Map();
const runtimeTimeouts = new Map();
const runtimeWatchers = [];
let clearedIntervals = 0;
const fleetRuntime = {
	watchSession(path, onChange, onError) { const entry = { path, onChange, onError, closed: false }; runtimeWatchers.push(entry); return { close() { entry.closed = true; } }; },
	setInterval(callback) { const id = nextRuntimeId++; runtimeIntervals.set(id, callback); return id; },
	clearInterval(id) { if (runtimeIntervals.delete(id)) clearedIntervals += 1; },
	setTimeout(callback) { const id = nextRuntimeId++; runtimeTimeouts.set(id, callback); return id; },
	clearTimeout(id) { runtimeTimeouts.delete(id); },
	async readTokens() { return liveTokens; },
};
let requestedFleetRenders = 0;
const liveWidgetBatch = { runId: "live", label: "live", status: "running", activity: [{ index: 0, name: "inspect", agent: "explorer", status: "running", startedAt: elapsedStart, activeStartedAt: elapsedStart, sessionFile: "/tmp/fleet-live/session.jsonl", paneId: "p1" }], prompts: [], tasks: [], documents: [], summary: "", ok: false, requestedConcurrency: 1, effectiveConcurrency: 1, recordDirectory: "/tmp/fleet-live" };
const liveWidget = new FleetWidget({ requestRender() { requestedFleetRenders += 1; } }, { fg: (_color, text) => text, bold: (text) => text }, liveWidgetBatch, new FleetSelection(), fleetRuntime);
for (const callback of [...runtimeTimeouts.values()]) callback();
runtimeTimeouts.clear();
await new Promise((resolve) => setTimeout(resolve, 0));
check("Fleet widget reads usage on demand and uses one running repaint timer", liveWidget.render(80)[1].includes("42 tok") && runtimeWatchers.length === 1 && runtimeIntervals.size === 1 && requestedFleetRenders > 0);
liveTokens = 84;
runtimeWatchers[0].onChange();
for (const callback of [...runtimeTimeouts.values()]) callback();
runtimeTimeouts.clear();
await new Promise((resolve) => setTimeout(resolve, 0));
check("Fleet widget refreshes token usage from file events", liveWidget.render(80)[1].includes("84 tok"));
liveTokens = 126;
for (const callback of [...runtimeIntervals.values()]) callback();
for (const callback of [...runtimeTimeouts.values()]) callback();
runtimeTimeouts.clear();
await new Promise((resolve) => setTimeout(resolve, 0));
check("Fleet widget refreshes token usage on every running one-second tick", liveWidget.render(80)[1].includes("126 tok"));
liveWidget.update({ ...liveWidgetBatch, status: "blocked", activity: [{ ...liveWidgetBatch.activity[0], status: "blocked", updatedAt: "2026-10-08T07:00:05.000Z", activeStartedAt: undefined, elapsedMs: 5_000 }] });
check("Fleet widget stops elapsed repainting when work blocks", runtimeIntervals.size === 0 && clearedIntervals === 1);
liveWidget.dispose();
const watcherClosed = runtimeWatchers.every((watcher) => watcher.closed);
liveWidget.update(liveWidgetBatch);
check("Fleet widget disposal closes watchers and prevents timer restart", watcherClosed && runtimeIntervals.size === 0 && runtimeTimeouts.size === 0);
const makeFleetUi = () => {
	let component;
	let factoryInstalls = 0;
	return {
		ui: {
			setWidget(_key, content) { component?.dispose?.(); component = undefined; if (typeof content === "function") { factoryInstalls += 1; component = content({ requestRender() {}, focusedComponent: undefined }, { fg: (_color, text) => text, bold: (text) => text }); } },
			onTerminalInput() { return () => {}; },
			getEditorText() { return ""; },
		},
		get component() { return component; },
		get factoryInstalls() { return factoryInstalls; },
	};
};
const firstFleetUi = makeFleetUi();
const secondFleetUi = makeFleetUi();
const fleetController = new FleetController({}, () => false, undefined, fleetRuntime);
fleetController.bind(firstFleetUi.ui, true);
fleetController.setActive(liveWidgetBatch);
const firstUiWidget = firstFleetUi.component;
fleetController.bind(secondFleetUi.ui, true);
fleetController.sync(liveWidgetBatch);
check("Fleet UI rebinding replaces the disposed widget in the new context", firstUiWidget !== secondFleetUi.component && secondFleetUi.factoryInstalls === 1);
fleetController.sync({ ...liveWidgetBatch, runId: "foreign", label: "foreign" });
check("foreign run updates do not replace the active Fleet owner", fleetController.active?.runId === "live" && secondFleetUi.factoryInstalls === 1);
const installsBeforeShutdown = secondFleetUi.factoryInstalls;
fleetController.shutdown();
fleetController.sync(liveWidgetBatch);
check("late updates after shutdown cannot recreate Fleet resources", secondFleetUi.factoryInstalls === installsBeforeShutdown && runtimeIntervals.size === 0 && !fleetController.active);
let resolveStaleTokens;
const staleTimeouts = new Map();
const staleWatchers = [];
let staleId = 1;
const staleRuntime = {
	watchSession(path, onChange) { const watcher = { path, onChange, closed: false }; staleWatchers.push(watcher); return { close() { watcher.closed = true; } }; },
	setInterval() { return staleId++; },
	clearInterval() {},
	setTimeout(callback) { const id = staleId++; staleTimeouts.set(id, callback); return id; },
	clearTimeout(id) { staleTimeouts.delete(id); },
	readTokens() { return new Promise((resolve) => { resolveStaleTokens = resolve; }); },
};
const staleWidget = new FleetWidget({ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, liveWidgetBatch, new FleetSelection(), staleRuntime);
for (const callback of [...staleTimeouts.values()]) callback();
staleTimeouts.clear();
staleWidget.update({ ...liveWidgetBatch, runId: "replacement", activity: [{ ...liveWidgetBatch.activity[0], sessionFile: "/tmp/fleet-replacement/session.jsonl" }] });
resolveStaleTokens(999);
await new Promise((resolve) => setTimeout(resolve, 0));
check("Fleet ignores stale token reads after session sources change", !staleWidget.render(80)[1].includes("999 tok"));
staleWidget.dispose();

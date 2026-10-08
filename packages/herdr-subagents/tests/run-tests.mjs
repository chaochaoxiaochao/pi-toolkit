import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getEventListeners } from "node:events";
import { visibleWidth } from "@earendil-works/pi-tui";
import { discoverPackageAgents, parseAgentMarkdown } from "../src/personas.ts";
import { loadSubagentConfiguration } from "../src/config.ts";
import { runHerdrSubagents } from "../src/runner.ts";
import { executeHerdrSubagents } from "../src/tool.ts";
import { activityCounts, focusActiveTask } from "../src/monitor.ts";
import { RunDispatcher } from "../src/dispatcher.ts";
import { ensureRuntimeIgnored, historyText, listSubagentHistory } from "../src/history.ts";
import { writeJsonAtomic } from "../src/state.ts";
import { cancelQueuedRuns, loadQueuedRuns, persistQueuedRun } from "../src/queued-runs.ts";
import { cancelActiveSubagentRuns, reconcileSubagentRuns } from "../src/reconcile.ts";
import { continueQueuedRun } from "../src/continue-run.ts";
import { CliHerdrAutomation } from "../src/herdr.ts";
import { aggregateSessionTokens, fleetEditorHasFocus, FleetSelection, fleetLines, formatFleetDuration, formatFleetTokens } from "../src/fleet.ts";
import { FleetController, FleetWidget } from "../src/fleet-controller.ts";
import { HERDR_ACTIONS, validateControlParams, validateRunParams } from "../src/validation.ts";
import { resultPathForAttempt } from "../src/result-path.ts";
import { applyTaskStatus, isSettledRunStatus, projectTaskActivity, readTaskRecord } from "../src/records.ts";
import { RunPaneAllocator } from "../src/run-pane-allocator.ts";
import { aggregateTaskStatus } from "../src/run-status.ts";
import { isAbortError } from "../src/errors.ts";

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
	if (condition) {
		passed += 1;
		console.log(`PASS ${name}`);
	} else {
		failed += 1;
		console.log(`FAIL ${name} ${detail}`);
	}
}

const root = mkdtempSync(join(tmpdir(), "pi-herdr-subagents-test-"));
const oldEnv = { ...process.env };
function setEnv(values) {
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, oldEnv, values);
}
function restoreEnv() {
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, oldEnv);
}

function fakeHerdr(mode = "completed") {
	const calls = [];
	let taskDirectory;
	let paneSequence = 2;
	let active = 0;
	let maxActive = 0;
	let taskRuns = 0;
	const agents = new Map();
	return {
		calls,
		get maxActive() { return maxActive; },
		async createTab(request) {
			calls.push(["createTab", request]);
			taskDirectory = request.env.PI_HERDR_SUBAGENTS_TASK_DIR;
			return { tabId: "w1:t2", paneId: "w1:p2" };
		},
		async startAgent(request) {
			calls.push(["startAgent", request]);
			const sessionIndex = request.args.indexOf("--session");
			agents.set(request.name, { directory: sessionIndex >= 0 ? join(request.args[sessionIndex + 1], "..") : taskDirectory, request });
		},
		async promptAgent(request) {
			calls.push(["promptAgent", request]);
			const current = agents.get(request.target) ?? { directory: taskDirectory };
			const directory = current.directory;
			taskRuns += 1;
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, request.prompt.includes("slow") ? 15 : 2));
			if (mode === "report-then-post-fail") {
				writeFileSync(join(directory, "report.json"), JSON.stringify({ status: "completed", summary: "Authoritative report completed before transport failed.", documents: [] }));
				active -= 1;
				throw new Error("connection lost after authoritative report");
			}
			if (mode === "post-fail" || (mode === "blocked-then-post-fail" && taskRuns > 1)) { active -= 1; throw new Error("connection lost after prompt submission"); }
			writeFileSync(join(directory, "session.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: request.target, cwd: root })}\n`);
			if (mode === "completed" || mode === "close-failed") {
				const failed = request.prompt.includes("FAIL");
				writeFileSync(join(directory, "result.md"), request.prompt.startsWith("Review") ? "FULL RESULT THAT STAYS OUT OF PARENT CONTEXT" : `FULL ${request.prompt}`);
				writeFileSync(join(directory, "report.json"), JSON.stringify({
					status: failed ? "failed" : "completed",
					summary: request.prompt.startsWith("Review") ? "Authentication review completed." : failed ? `${request.prompt} failed.` : `${request.prompt} completed.`,
					...(failed ? { error: "expected failure" } : {}),
					documents: [{ path: join(directory, "result.md"), description: "Full result" }],
				}));
			} else if (mode === "failed") {
				writeFileSync(join(directory, "result.md"), "Provider stopped before completing the review.");
				writeFileSync(join(directory, "report.json"), JSON.stringify({
					status: "failed",
					summary: "Authentication review failed.",
					error: "provider unavailable",
					documents: [],
				}));
			} else if (mode === "malformed") {
				writeFileSync(join(directory, "report.json"), "{truncated");
			} else if (mode === "blocked" || mode === "blocked-twice" || mode === "blocked-then-post-fail") {
				const needsInput = ((mode === "blocked" || mode === "blocked-then-post-fail") && taskRuns === 1) || (mode === "blocked-twice" && (taskRuns === 1 || taskRuns === 3));
				const failed = request.prompt.includes("FAIL");
				const question = taskRuns === 3 ? "Which environment should I inspect?" : "Which branch should I inspect?";
				writeFileSync(join(directory, "result.md"), `FULL ${request.prompt}`);
				writeFileSync(join(directory, "report.json"), JSON.stringify({ status: needsInput ? "needs-input" : failed ? "failed" : "completed", summary: needsInput ? "Need more input." : failed ? `${request.prompt} failed.` : `${request.prompt} completed.`, ...(needsInput ? { question } : {}), ...(failed ? { error: "expected failure" } : {}), documents: [] }));
			}
			active -= 1;
			return { status: mode === "failed" ? "done" : "idle" };
		},
		async splitPane(request) {
			calls.push(["splitPane", request]);
			paneSequence += 1;
			return { paneId: `w1:p${paneSequence}` };
		},
		async renamePane(paneId, label) { calls.push(["renamePane", { paneId, label }]); },
		async renameTab(tabId, label) { calls.push(["renameTab", { tabId, label }]); },
		async focusPane(paneId) { calls.push(["focusPane", { paneId }]); },
		async isTabFocused(tabId) { calls.push(["isTabFocused", { tabId }]); return mode === "focused"; },
		async waitForTabUnfocused(tabId) { calls.push(["waitForTabUnfocused", { tabId }]); },
		async paneExists(paneId) { calls.push(["paneExists", { paneId }]); return mode !== "missing-pane"; },
		async isTaskRunning(paneId) { calls.push(["isTaskRunning", { paneId }]); return mode !== "missing-pane" && mode !== "shell-only"; },
		async closeTab(tabId) {
			calls.push(["closeTab", { tabId }]);
			if (mode === "close-failed") throw new Error("tab still busy");
		},
	};
}

function latestRunDirectory() {
	const runs = join(root, ".pi", "herdr-subagents", "runs");
	const entries = readdirSync(runs).sort();
	return join(runs, entries[entries.length - 1]);
}

try {
	check("run validation accepts one or more tasks", validateRunParams({ tasks: [{ name: "one", prompt: "do it" }], concurrency: 2, background: true }) === undefined);
	check("control validation accepts supported calls", [
		{ action: "list" }, { action: "history" }, { action: "cleanup", runId: "run" },
		{ action: "respond", runId: "run", answer: "yes", task: 1 },
		{ action: "resume", runId: "run", task: 1, prompt: "continue" },
	].every((params) => validateControlParams(params) === undefined));
	check("all supported actions have shared validation and rendering metadata", ["list", "history", "cleanup", "respond", "resume"].every((action) => action in HERDR_ACTIONS));
	check("split validation rejects missing tasks and invalid control fields", [
		validateRunParams({ tasks: [] }),
		validateControlParams({ action: "list", prompt: "not allowed" }),
		validateControlParams({ action: "respond", runId: "run" }),
		validateControlParams({ action: "resume", runId: "run", task: 1 }),
	].every((message) => typeof message === "string" && message.length > 0));
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
	let unknownStatusRejected = false;
	try { aggregateTaskStatus(["unknown"]); } catch { unknownStatusRejected = true; }
	check("task status aggregation rejects unknown states", unknownStatusRejected);
	check("all execution paths share abort classification", isAbortError(Object.assign(new Error("stopped"), { name: "AbortError" })) && isAbortError(new Error("operation aborted")) && !isAbortError(new Error("provider unavailable")));
	check("respond releases ownership only for explicit terminal statuses", ["completed", "partial", "failed", "cancelled"].every(isSettledRunStatus) && !isSettledRunStatus("blocked") && !isSettledRunStatus(undefined));

	setEnv({ HERDR_ENV: "0", PI_HERDR_SUBAGENTS_PI_BINARY: "/definitely/missing/pi" });
	const unavailableHerdr = fakeHerdr();
	const outside = await runHerdrSubagents("hello", { cwd: root, herdr: unavailableHerdr });
	check("Herdr is required", !outside.ok && outside.errorMessage?.includes("inside Herdr") && unavailableHerdr.calls.length === 0);

	setEnv({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", PI_HERDR_SUBAGENTS_PI_BINARY: "/definitely/missing/pi" });
	const herdr = fakeHerdr();
	const success = await runHerdrSubagents("Review authentication", {
		cwd: root,
		label: "auth-review",
		agent: "worker",
		model: "fake/model",
		tools: ["read", "grep"],
		systemPrompt: "You are a focused worker.",
		herdr,
	});
	check("compact successful report", success.ok && success.status === "completed" && success.summary === "Authentication review completed." && success.documents.length === 1 && !success.output.includes("FULL RESULT"));
	check("Herdr lifecycle", herdr.calls.map(([name]) => name).join(",") === "createTab,renamePane,startAgent,promptAgent,isTabFocused,closeTab");
	const createRequest = herdr.calls.find(([name]) => name === "createTab")[1];
	const startRequest = herdr.calls.find(([name]) => name === "startAgent")[1];
	check("named unfocused tab in parent workspace", createRequest.workspaceId === "w1" && createRequest.cwd === root && createRequest.label === "SA · auth-review" && createRequest.focus === false);
	check("ordinary execution never steals pane focus", !herdr.calls.some(([name]) => name === "focusPane"));
	check("child environment points at durable task", createRequest.env.PI_HERDR_SUBAGENTS_CHILD === "1" && createRequest.env.PI_HERDR_SUBAGENTS_TASK_DIR.includes(join(".pi", "herdr-subagents", "runs")));
	check("persistent isolated child Pi", startRequest.kind === "pi" && startRequest.paneId === "w1:p2" && startRequest.args.includes("--session") && startRequest.args.includes("--no-extensions") && startRequest.args.includes("--extension") && startRequest.args.includes("--no-skills") && startRequest.args.includes("--model") && startRequest.args.includes("fake/model") && startRequest.args.includes("--tools") && startRequest.args.includes("read,grep,subagent_report"));
	const promptRequest = herdr.calls.find(([name]) => name === "promptAgent")[1];
	check("prompt submitted through Herdr", promptRequest.prompt === "Review authentication" && promptRequest.target === startRequest.name);

	const runDirectory = latestRunDirectory();
	const runRecord = JSON.parse(readFileSync(join(runDirectory, "run.json"), "utf8"));
	const taskDirectory = join(runDirectory, "tasks", readdirSync(join(runDirectory, "tasks"))[0]);
	const taskRecord = JSON.parse(readFileSync(join(taskDirectory, "task.json"), "utf8"));
	check("run and task records settle with pane and Agent identity", runRecord.status === "completed" && taskRecord.status === "completed" && taskRecord.prompt === "Review authentication" && taskRecord.model === "fake/model" && taskRecord.paneLabel === "01 · auth-review" && taskRecord.agentName === startRequest.name);
	check("full result and session stay on disk", readFileSync(join(taskDirectory, "result.md"), "utf8").startsWith("FULL RESULT") && existsSync(join(taskDirectory, "session.jsonl")));

	const extensionHerdr = fakeHerdr();
	const publicResult = await executeHerdrSubagents({ agent: "worker", prompt: "Review through the public tool" }, undefined, undefined, {
		cwd: root,
		model: { provider: "fake", id: "model" },
		thinkingLevel: "medium",
	}, { agentsDirectory: join(process.cwd(), "agents"), herdr: extensionHerdr });
	check("public extension behavior uses injectable Herdr", !publicResult.isError && publicResult.content[0].text.includes("Authentication review completed.") && !publicResult.content[0].text.includes("FULL RESULT") && extensionHerdr.calls.map(([name]) => name).join(",") === "createTab,renamePane,startAgent,promptAgent,isTabFocused,closeTab", JSON.stringify({ publicResult, calls: extensionHerdr.calls.map(([name]) => name) }));
	let singleStalledWarning = "";
	await runHerdrSubagents("single slow task", { cwd: root, herdr: fakeHerdr(), stalledWarningSeconds: 0.001, onStalled: (message) => { singleStalledWarning = message; } });
	check("single-task execution emits configured stalled warning", singleStalledWarning.includes("appears stalled"));

	const failedHerdr = fakeHerdr("failed");
	const failedRun = await runHerdrSubagents("Fail cleanly", { cwd: root, herdr: failedHerdr });
	check("structured child failure", !failedRun.ok && failedRun.status === "failed" && failedRun.summary === "Authentication review failed." && failedRun.errorMessage === "provider unavailable" && failedHerdr.calls.at(-1)[0] === "closeTab");

	const silentHerdr = fakeHerdr("silent");
	const silent = await runHerdrSubagents("Forget report", { cwd: root, herdr: silentHerdr });
	check("missing report is visible failure", !silent.ok && silent.errorMessage?.includes("did not submit") && silentHerdr.calls.at(-1)[0] === "closeTab");
	const malformedExecutionHerdr = fakeHerdr("malformed");
	const malformedExecution = await runHerdrSubagents("Write malformed report", { cwd: root, herdr: malformedExecutionHerdr });
	const malformedExecutionTaskDirectory = malformedExecution.recordDirectory;
	const repairedExecutionReport = JSON.parse(readFileSync(join(malformedExecutionTaskDirectory, "report.json"), "utf8"));
	check("malformed child report becomes a durable usable failure", !malformedExecution.ok && repairedExecutionReport.status === "failed" && readdirSync(malformedExecutionTaskDirectory).some((entry) => entry.startsWith("report.json.invalid-")) && (await listSubagentHistory(root)).some((run) => run.id === malformedExecution.runId));
	const firstResultPath = resultPathForAttempt(join(root, "report-tool"), 1);
	const secondResultPath = resultPathForAttempt(join(root, "report-tool"), 2);
	check("historical attempts use distinct full-result documents", firstResultPath.endsWith("/result.md") && secondResultPath.endsWith("/turns/02-result.md") && firstResultPath !== secondResultPath);

	const cleanupHerdr = fakeHerdr("close-failed");
	const cleanupFailure = await runHerdrSubagents("Complete then fail cleanup", { cwd: root, herdr: cleanupHerdr });
	const cleanupRunDirectory = latestRunDirectory();
	const cleanupRunRecord = JSON.parse(readFileSync(join(cleanupRunDirectory, "run.json"), "utf8"));
	const cleanupTaskDirectory = join(cleanupRunDirectory, "tasks", readdirSync(join(cleanupRunDirectory, "tasks"))[0]);
	const cleanupTaskRecord = JSON.parse(readFileSync(join(cleanupTaskDirectory, "task.json"), "utf8"));
	check("tab cleanup failure settles records as failed", !cleanupFailure.ok && cleanupFailure.errorMessage?.includes("cleanup failed") && cleanupRunRecord.status === "failed" && cleanupTaskRecord.status === "failed");

	const definition = parseAgentMarkdown(`---\nname: reviewer\ndescription: Review code\nmodel: fake/model\ntools: read, grep\n---\nReview carefully.`, "reviewer.md");
	check("persona frontmatter parsing", definition.name === "reviewer" && definition.model === "fake/model" && definition.tools?.join(",") === "read,grep" && definition.systemPrompt === "Review carefully.");
	const agentsDir = join(root, "agents");
	await import("node:fs/promises").then(({ mkdir }) => mkdir(agentsDir));
	writeFileSync(join(agentsDir, "worker.md"), `---\nname: worker\ndescription: Worker\n---\nDo work.`);
	writeFileSync(join(agentsDir, "broken.md"), "not frontmatter");
	const discovery = discoverPackageAgents(agentsDir);
	check("persona discovery and diagnostics", discovery.agents.length === 1 && discovery.agents[0].name === "worker" && discovery.diagnostics.length === 1);

	const configRoot = join(root, "configuration");
	const packageAgents = join(configRoot, "package-agents");
	const globalAgents = join(configRoot, "global-agents");
	const projectAgents = join(configRoot, "project-agents");
	mkdirSync(packageAgents, { recursive: true });
	mkdirSync(globalAgents, { recursive: true });
	mkdirSync(projectAgents, { recursive: true });
	writeFileSync(join(packageAgents, "worker.md"), `---\nname: worker\ndescription: Package worker\naccess: write\nmodel: package/model\nskills: package-skill\n---\nPackage prompt.`);
	writeFileSync(join(packageAgents, "explorer.md"), `---\nname: explorer\ndescription: Package explorer\naccess: read\n---\nExplore.`);
	writeFileSync(join(packageAgents, "thinker.md"), `---\nname: thinker\ndescription: Package thinker\nthinking: minimal\n---\nThink.`);
	writeFileSync(join(globalAgents, "worker.md"), `---\nname: worker\ndescription: Global worker\naccess: read\n---\nGlobal prompt.`);
	writeFileSync(join(projectAgents, "worker.md"), `---\nname: worker\ndescription: Project worker\n---\nProject prompt.`);
	const globalConfig = join(configRoot, "global.json");
	const projectConfig = join(configRoot, "project.json");
	writeFileSync(globalConfig, JSON.stringify({ maxConcurrency: 8, defaultModel: "global/default", defaultThinking: "medium", personas: { worker: { model: "global/worker", thinking: "low", skills: ["global-skill"] } } }));
	writeFileSync(projectConfig, JSON.stringify({ maxConcurrency: 3, defaultThinking: "high", personas: { worker: { model: "project/worker", thinking: "high", skills: ["project-skill"] } } }));
	const configurationPaths = { globalConfig, projectConfig, globalAgents, projectAgents };
	const configuration = loadSubagentConfiguration(configRoot, packageAgents, "parent/model", configurationPaths);
	const configuredWorker = configuration.personas.find((persona) => persona.name === "worker");
	const configuredExplorer = configuration.personas.find((persona) => persona.name === "explorer");
	const configuredThinker = configuration.personas.find((persona) => persona.name === "thinker");
	check("built-in settings recursively merge global then project", configuration.settings.defaultConcurrency === 1 && configuration.settings.maxConcurrency === 3 && configuration.settings.defaultModel === "global/default" && configuration.settings.defaultThinking === "high" && configuration.settingSources.maxConcurrency === "project" && configuration.settingSources.defaultThinking === "project");
	check("persona definitions use project global package precedence", configuredWorker?.source === "project" && configuredWorker.description === "Project worker" && configuredWorker.systemPrompt === "Project prompt." && configuredWorker.access === "write" && configuredExplorer?.source === "package" && configuredExplorer.access === "read");
	check("persona configuration resolves model thinking and skills", configuredWorker?.model === "project/worker" && configuredWorker.modelSource === "project persona" && configuredWorker.thinking === "high" && configuredWorker.skills.join(",") === "project-skill");
	check("project default thinking applies below persona settings", configuredExplorer?.thinking === "high" && configuredExplorer.thinkingSource === "project");
	check("persona Markdown thinking overrides default thinking", configuredThinker?.thinking === "minimal" && configuredThinker.thinkingSource === "package persona");
	writeFileSync(projectConfig, JSON.stringify({ defaultThinking: [], personas: { worker: { model: 42, thinking: [], skills: "invalid" } } }));
	const invalidConfiguration = loadSubagentConfiguration(configRoot, packageAgents, "parent/model", configurationPaths);
	const invalidWorker = invalidConfiguration.personas.find((persona) => persona.name === "worker");
	check("invalid persona fields are diagnosed and ignored", invalidWorker?.model === "global/worker" && invalidWorker.thinking === "low" && invalidWorker.skills.join(",") === "global-skill" && invalidConfiguration.diagnostics.filter((message) => message.includes("persona 'worker'")).length === 3);
	const invalidExplorer = invalidConfiguration.personas.find((persona) => persona.name === "explorer");
	check("invalid project default thinking is diagnosed and global default remains effective", invalidExplorer?.thinking === "medium" && invalidExplorer.thinkingSource === "global" && invalidConfiguration.diagnostics.some((message) => message === "project defaultThinking must be a non-empty string"));
	writeFileSync(projectConfig, JSON.stringify({ maxConcurrency: 3, defaultThinking: "high", personas: { worker: { model: "project/worker", thinking: "high", skills: ["project-skill"] } } }));
	const configuredHerdr = fakeHerdr();
	const configuredRun = await executeHerdrSubagents({ agent: "worker", model: "task/model", prompt: "Use configured values" }, undefined, undefined, { cwd: configRoot, model: { provider: "parent", id: "model" }, thinkingLevel: "medium" }, { agentsDirectory: packageAgents, configurationPaths, herdr: configuredHerdr });
	const configuredStart = configuredHerdr.calls.find(([name]) => name === "startAgent")[1];
	check("configured persona uses displayed effective values", !configuredRun.isError && configuredStart.args.includes("task/model") && configuredStart.args.includes("high") && configuredStart.args.includes("--skill") && configuredStart.args.includes("project-skill"));

	const batchHerdr = fakeHerdr();
	const batchUpdates = [];
	const batch = await executeHerdrSubagents({ label: "reviews", concurrency: 2, tasks: [
		{ name: "one", prompt: "one slow", agent: "explorer" },
		{ name: "two", prompt: "two", agent: "reviewer" },
		{ name: "three", prompt: "three FAIL", agent: "explorer" },
		{ name: "four", prompt: "four", agent: "reviewer" },
	] }, undefined, (update) => batchUpdates.push(update.details), { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: batchHerdr });
	const batchDetails = batch.details;
	const batchPrompts = batchHerdr.calls.filter(([name]) => name === "promptAgent").map(([, request]) => request.prompt);
	const batchStarts = batchHerdr.calls.filter(([name]) => name === "startAgent").map(([, request]) => request);
	check("read-only batch uses bounded concurrency", batchDetails.effectiveConcurrency === 2 && batchHerdr.maxActive === 2 && batchHerdr.calls.filter(([name]) => name === "splitPane").length === 3);
	check("batch is FIFO with a dedicated pane per task", batchPrompts.join(",") === "one slow,two,three FAIL,four" && new Set(batchStarts.map((request) => request.paneId)).size === 4);
	check("failed sibling does not cancel batch", batch.isError && batchDetails.status === "partial" && batchDetails.tasks.map((task) => task.name).join(",") === "one,two,three,four" && batchDetails.tasks[2].status === "failed" && batchDetails.tasks[3].status === "completed");
	const batchCleanupHerdr = fakeHerdr("close-failed");
	const batchCleanup = await executeHerdrSubagents({ tasks: [{ name: "cleanup", prompt: "cleanup", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: batchCleanupHerdr });
	const batchCleanupRecord = JSON.parse(readFileSync(join(batchCleanup.details.recordDirectory, "run.json"), "utf8"));
	check("batch cleanup failure is persisted and surfaced", batchCleanup.isError && batchCleanup.content[0].text.includes("cleanup failed") && batchCleanupRecord.status === "failed" && batchCleanupRecord.cleanupError.includes("tab still busy"));
	const cleanupProbeHerdr = fakeHerdr();
	cleanupProbeHerdr.isTabFocused = async () => { throw new Error("tab lookup failed"); };
	const cleanupProbe = await executeHerdrSubagents({ tasks: [{ name: "cleanup-probe", prompt: "cleanup probe", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: cleanupProbeHerdr });
	const cleanupProbeRecord = JSON.parse(readFileSync(join(cleanupProbe.details.recordDirectory, "run.json"), "utf8"));
	check("cleanup focus-probe failure is persisted and surfaced", cleanupProbe.isError && cleanupProbe.content[0].text.includes("tab lookup failed") && cleanupProbeRecord.status === "failed" && cleanupProbeRecord.cleanupError === "tab lookup failed");
	const activeUpdate = batchUpdates.find((update) => update.activity?.some((task) => task.status === "running"));
	const counts = activityCounts(activeUpdate);
	const focusHerdr = fakeHerdr();
	const runningTask = activeUpdate.activity.find((task) => task.status === "running");
	check("activity projections expose true persona task timing and session sources", runningTask.agent === "explorer" && runningTask.name === "one" && runningTask.prompt === "one slow" && typeof runningTask.startedAt === "string" && runningTask.sessionFile.endsWith("session.jsonl"));
	const focused = await focusActiveTask(activeUpdate, runningTask.index + 1, focusHerdr);
	check("active progress exposes widget counts and exact pane navigation", counts.running > 0 && counts.queued > 0 && focused && focusHerdr.calls.at(-1)[0] === "focusPane" && focusHerdr.calls.at(-1)[1].paneId === runningTask.paneId);
	const settledFocused = await focusActiveTask({ activity: [{ index: 0, name: "settled", status: "completed", paneId: "w1:p-settled" }] }, 1, focusHerdr);
	check("settled Fleet rows remain selectable while the batch is open", settledFocused && focusHerdr.calls.at(-1)[1].paneId === "w1:p-settled");
	const paneLabels = batchHerdr.calls.filter(([name]) => name === "renamePane").map(([, request]) => request.label);
	check("tab and dedicated panes use short stable labels", batchHerdr.calls[0][1].label === "SA · reviews" && paneLabels.includes("01 · one") && paneLabels.includes("04 · four"));
	const writerHerdr = fakeHerdr();
	const writerBatch = await executeHerdrSubagents({ concurrency: 3, tasks: [{ name: "write-one", prompt: "write one" }, { name: "write-two", prompt: "write two" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: writerHerdr });
	check("write-capable batch is forced serial", writerBatch.details.effectiveConcurrency === 1 && writerHerdr.maxActive === 1 && writerHerdr.calls.filter(([name]) => name === "splitPane").length === 1);
	const focusedHerdr = fakeHerdr("focused");
	await executeHerdrSubagents({ tasks: [{ name: "inspect", prompt: "inspect", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: focusedHerdr });
	await new Promise((resolve) => setTimeout(resolve, 0));
	const focusedCalls = focusedHerdr.calls.map(([name]) => name);
	check("focused completed tab defers cleanup until focus leaves", focusedCalls.indexOf("waitForTabUnfocused") >= 0 && focusedCalls.indexOf("closeTab") > focusedCalls.indexOf("waitForTabUnfocused"));
	const pendingCleanupHerdr = fakeHerdr();
	let releasePendingCleanup;
	pendingCleanupHerdr.isTabFocused = async () => true;
	pendingCleanupHerdr.waitForTabUnfocused = async () => new Promise((resolve) => { releasePendingCleanup = resolve; });
	const pendingCleanupRun = await executeHerdrSubagents({ tasks: [{ name: "pending-cleanup", prompt: "inspect", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: pendingCleanupHerdr });
	const pendingCleanupRecord = JSON.parse(readFileSync(join(pendingCleanupRun.details.recordDirectory, "run.json"), "utf8"));
	const cleanupWhilePending = await executeHerdrSubagents({ action: "cleanup", runId: pendingCleanupRun.details.runId }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: pendingCleanupHerdr });
	const resumeWhilePending = await executeHerdrSubagents({ action: "resume", runId: pendingCleanupRun.details.runId, task: 1, prompt: "too soon" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: pendingCleanupHerdr });
	check("pending tab cleanup blocks history resume and deletion", pendingCleanupRecord.cleanupPendingTabIds?.includes(pendingCleanupRun.details.tabId) && cleanupWhilePending.isError && resumeWhilePending.isError);
	releasePendingCleanup();
	await new Promise((resolve) => setTimeout(resolve, 10));
	const releasedCleanupRecord = JSON.parse(readFileSync(join(pendingCleanupRun.details.recordDirectory, "run.json"), "utf8"));
	check("deferred cleanup merges into the latest run record", releasedCleanupRecord.status === "completed" && !("cleanupPendingTabIds" in releasedCleanupRecord));
	const shutdownDeferredHerdr = fakeHerdr();
	shutdownDeferredHerdr.isTabFocused = async () => true;
	shutdownDeferredHerdr.waitForTabUnfocused = async (tabId, signal) => {
		shutdownDeferredHerdr.calls.push(["waitForTabUnfocused", { tabId }]);
		return await new Promise((resolve, reject) => {
			if (signal?.aborted) reject(signal.reason);
			else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	};
	const shutdownDeferredController = new AbortController();
	await executeHerdrSubagents({ tasks: [{ name: "shutdown-deferred", prompt: "inspect", agent: "explorer" }] }, shutdownDeferredController.signal, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: shutdownDeferredHerdr });
	shutdownDeferredController.abort(new Error("Parent Pi session closed."));
	await new Promise((resolve) => setTimeout(resolve, 10));
	check("parent shutdown force-closes a settled focused tab", shutdownDeferredHerdr.calls.some(([name]) => name === "closeTab"));
	const deferredFailureHerdr = fakeHerdr();
	deferredFailureHerdr.isTabFocused = async () => true;
	deferredFailureHerdr.closeTab = async () => { throw new Error("deferred close failed"); };
	const deferredFailure = await executeHerdrSubagents({ tasks: [{ name: "deferred-cleanup", prompt: "inspect", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: deferredFailureHerdr });
	await new Promise((resolve) => setTimeout(resolve, 10));
	const deferredFailureRecord = JSON.parse(readFileSync(join(deferredFailure.details.recordDirectory, "run.json"), "utf8"));
	check("deferred focus cleanup failure remains durably retryable", deferredFailureRecord.cleanupError === "deferred close failed" && deferredFailureRecord.cleanupPendingTabIds?.includes(deferredFailure.details.tabId));
	const deferredSingleHerdr = fakeHerdr();
	deferredSingleHerdr.isTabFocused = async () => true;
	deferredSingleHerdr.closeTab = async () => { throw new Error("single deferred close failed"); };
	const deferredSingleUpdates = [];
	const deferredSingle = await executeHerdrSubagents({ prompt: "single deferred cleanup", agent: "explorer" }, undefined, (update) => deferredSingleUpdates.push(update), { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: deferredSingleHerdr });
	await new Promise((resolve) => setTimeout(resolve, 10));
	const deferredSingleRun = JSON.parse(readFileSync(join(deferredSingle.details.recordDirectory, "..", "..", "run.json"), "utf8"));
	check("deferred single-task cleanup failure is persisted and surfaced", deferredSingleRun.status === "failed" && deferredSingleRun.cleanupError === "single deferred close failed" && deferredSingleUpdates.some((update) => update.content[0].text.includes("cleanup failed")));
	const cancelledHerdr = fakeHerdr();
	cancelledHerdr.isTabFocused = async (tabId) => { cancelledHerdr.calls.push(["isTabFocused", { tabId }]); return true; };
	cancelledHerdr.waitForTabUnfocused = async () => { throw new Error("shutdown cleanup must not wait for focus"); };
	cancelledHerdr.promptAgent = async (request) => {
		cancelledHerdr.calls.push(["promptAgent", request]);
		await new Promise((resolve, reject) => {
			if (request.signal?.aborted) reject(request.signal.reason);
			else request.signal?.addEventListener("abort", () => reject(request.signal.reason), { once: true });
		});
	};
	const cancellation = new AbortController();
	const cancelledPromise = executeHerdrSubagents({ tasks: [{ name: "cancel-me", prompt: "wait", agent: "explorer" }] }, cancellation.signal, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: cancelledHerdr });
	await new Promise((resolve) => setTimeout(resolve, 5));
	cancellation.abort(new Error("Parent Pi session closed."));
	const cancelledBatch = await cancelledPromise;
	const cancelledTaskRecord = JSON.parse(readFileSync(join(cancelledBatch.details.recordDirectory, "tasks", readdirSync(join(cancelledBatch.details.recordDirectory, "tasks"))[0], "task.json"), "utf8"));
	check("already-aborted parent shutdown force-closes a focused active tab", cancelledBatch.details.status === "cancelled" && cancelledTaskRecord.status === "cancelled" && cancelledHerdr.calls.at(-1)[0] === "closeTab" && !cancelledHerdr.calls.some(([name]) => name === "isTabFocused" || name === "waitForTabUnfocused"));
	const cancelledSingleHerdr = fakeHerdr();
	cancelledSingleHerdr.promptAgent = async (request) => {
		cancelledSingleHerdr.calls.push(["promptAgent", request]);
		await new Promise((resolve, reject) => {
			if (request.signal?.aborted) reject(request.signal.reason);
			else request.signal?.addEventListener("abort", () => reject(request.signal.reason), { once: true });
		});
	};
	const singleCancellation = new AbortController();
	const cancelledSinglePromise = runHerdrSubagents("wait", { cwd: root, herdr: cancelledSingleHerdr, signal: singleCancellation.signal });
	await new Promise((resolve) => setTimeout(resolve, 5));
	singleCancellation.abort(new Error("Parent Pi session closed."));
	const cancelledSingle = await cancelledSinglePromise;
	const cancelledSingleRun = JSON.parse(readFileSync(join(cancelledSingle.recordDirectory, "..", "..", "run.json"), "utf8"));
	check("parent shutdown persists active single task as cancelled", cancelledSingle.status === "cancelled" && cancelledSingleRun.status === "cancelled" && cancelledSingleHerdr.calls.at(-1)[0] === "closeTab");

	const dispatchEvents = [];
	const dispatcher = new RunDispatcher((snapshot) => dispatchEvents.push(snapshot));
	let releaseFirst;
	let releaseSecond;
	const starts = [];
	const first = dispatcher.submit("run-one", async () => { starts.push("run-one"); await new Promise((resolve) => { releaseFirst = resolve; }); return "one"; });
	const second = dispatcher.submit("run-two", async () => { starts.push("run-two"); await new Promise((resolve) => { releaseSecond = resolve; }); return "two"; });
	await new Promise((resolve) => setTimeout(resolve, 0));
	check("dispatcher runs only one run and exposes queued successors", starts.join(",") === "run-one" && dispatcher.snapshot().activeRunId === "run-one" && dispatcher.snapshot().queuedRunIds.join(",") === "run-two");
	dispatcher.pause();
	releaseFirst();
	check("dispatcher returns first result and advances FIFO", await first === "one");
	await new Promise((resolve) => setTimeout(resolve, 0));
	check("parent shutdown pauses new queued dispatch", starts.join(",") === "run-one" && dispatcher.snapshot().queuedRunIds.join(",") === "run-two");
	dispatcher.resume();
	await new Promise((resolve) => setTimeout(resolve, 0));
	check("dispatcher starts next queued run automatically", starts.join(",") === "run-one,run-two" && dispatcher.snapshot().activeRunId === "run-two");
	releaseSecond();
	check("dispatcher settles queued run", await second === "two");
	const retainedDispatcher = new RunDispatcher();
	const retainedStarts = [];
	const retainedFirst = retainedDispatcher.submit("blocked-run", async () => { retainedStarts.push("blocked-run"); retainedDispatcher.retain("blocked-run"); return "blocked"; });
	const retainedSecond = retainedDispatcher.submit("queued-run", async () => { retainedStarts.push("queued-run"); return "completed"; });
	check("blocked run retains dispatcher ownership after its call returns", await retainedFirst === "blocked" && retainedDispatcher.snapshot().activeRunId === "blocked-run" && retainedStarts.join(",") === "blocked-run" && retainedDispatcher.snapshot().queuedRunIds.join(",") === "queued-run");
	retainedDispatcher.release("blocked-run");
	check("respond settlement releases dispatcher ownership to the queued run", await retainedSecond === "completed" && retainedStarts.join(",") === "blocked-run,queued-run");
	const backgroundId = "stable-background-id";
	const stableHerdr = fakeHerdr();
	const stable = await executeHerdrSubagents({ tasks: [{ name: "stable", prompt: "stable", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: stableHerdr, runId: backgroundId });
	check("preallocated background run id stays stable", stable.details.runId === backgroundId && readFileSync(join(stable.details.recordDirectory, "run.json"), "utf8").includes(backgroundId));

	const blockedHerdr = fakeHerdr("blocked");
	const blocked = await executeHerdrSubagents({ concurrency: 1, tasks: [{ name: "question", prompt: "inspect branch", agent: "explorer" }, { name: "after-answer", prompt: "continue queued", agent: "reviewer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: blockedHerdr });
	check("needs-input returns foreground control and preserves tab", blocked.details.status === "blocked" && blocked.details.tasks[0].question === "Which branch should I inspect?" && !blockedHerdr.calls.some(([name]) => name === "closeTab"));
	const activeCleanup = await executeHerdrSubagents({ action: "cleanup", runId: blocked.details.runId }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: blockedHerdr });
	check("cleanup refuses to delete an active blocked run", activeCleanup.isError && activeCleanup.content[0].text.includes("still active") && existsSync(blocked.details.recordDirectory));
	const resumeUpdates = [];
	const resumed = await executeHerdrSubagents({ action: "respond", runId: blocked.details.runId, answer: "Inspect main." }, undefined, (update) => resumeUpdates.push(update.details), { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: blockedHerdr });
	const blockedStarts = blockedHerdr.calls.filter(([name]) => name === "startAgent").map(([, request]) => request);
	const blockedPrompts = blockedHerdr.calls.filter(([name]) => name === "promptAgent").map(([, request]) => request);
	check("answer resumes original live Agent and queued sibling gets a new pane", !resumed.isError && resumed.details.status === "completed" && blockedPrompts.length === 3 && blockedPrompts[1].target === blockedPrompts[0].target && blockedStarts.length === 2 && new Set(blockedStarts.map((request) => request.paneId)).size === 2);
	check("answer streams live Fleet rows for resumed and newly allocated panes", resumeUpdates.some((update) => update.activity?.[0]?.status === "running" && update.activity[0].paneId) && resumeUpdates.some((update) => update.activity?.[1]?.status === "running" && update.activity[1].paneId));
	const resumedTasks = readdirSync(join(blocked.details.recordDirectory, "tasks")).sort().map((entry) => JSON.parse(readFileSync(join(blocked.details.recordDirectory, "tasks", entry, "task.json"), "utf8")));
	const resumedRunRecord = JSON.parse(readFileSync(join(blocked.details.recordDirectory, "run.json"), "utf8"));
	check("completion after answer continues queued siblings and settles original run", resumedRunRecord.status === "completed" && resumedTasks.every((task) => task.status === "completed") && blockedHerdr.calls.at(-1)[0] === "closeTab");
	check("blocked continuation preserves newly allocated pane IDs", resumedTasks.every((task) => resumedRunRecord.paneIds.includes(task.paneId)));
	const resumedTurn = JSON.parse(readFileSync(resumedTasks[0].currentTurnFile, "utf8"));
	check("authoritative response clears stale blocked fields", !("question" in resumedTasks[0]) && !("error" in resumedTasks[0]) && !("question" in resumedTurn) && !("error" in resumedTurn));
	const twiceBlockedHerdr = fakeHerdr("blocked-twice");
	const twiceBlocked = await executeHerdrSubagents({ concurrency: 1, tasks: [{ name: "first-question", prompt: "first", agent: "explorer" }, { name: "second-question", prompt: "second", agent: "reviewer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: twiceBlockedHerdr });
	const secondQuestion = await executeHerdrSubagents({ action: "respond", runId: twiceBlocked.details.runId, answer: "main" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: twiceBlockedHerdr });
	check("queued sibling blocking returns its current question and Fleet pane", secondQuestion.details.status === "blocked" && secondQuestion.details.question === "Which environment should I inspect?" && secondQuestion.content[0].text.includes("environment") && secondQuestion.details.activity[1].status === "blocked" && Boolean(secondQuestion.details.activity[1].paneId));
	const failedAfterBlockHerdr = fakeHerdr("blocked");
	const failedAfterBlock = await executeHerdrSubagents({ concurrency: 1, tasks: [{ name: "question-first", prompt: "question", agent: "explorer" }, { name: "fails-later", prompt: "FAIL sibling", agent: "reviewer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: failedAfterBlockHerdr });
	const failedAnswer = await executeHerdrSubagents({ action: "respond", runId: failedAfterBlock.details.runId, answer: "main" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: failedAfterBlockHerdr });
	check("failed sibling after answer appears in compact result", failedAnswer.isError && failedAnswer.details.status === "partial" && failedAnswer.content[0].text.includes("fails-later") && failedAnswer.content[0].text.includes("failed"));
	const responseFailureHerdr = fakeHerdr("blocked-then-post-fail");
	const responseFailureRun = await executeHerdrSubagents({ tasks: [{ name: "response-fails", prompt: "question", agent: "explorer" }] }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: responseFailureHerdr });
	const responseFailure = await executeHerdrSubagents({ action: "respond", runId: responseFailureRun.details.runId, answer: "main" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: responseFailureHerdr });
	const responseFailureTask = JSON.parse(readFileSync(join(responseFailureRun.details.recordDirectory, "tasks", readdirSync(join(responseFailureRun.details.recordDirectory, "tasks"))[0], "task.json"), "utf8"));
	check("failed blocked response settles durable task instead of leaving running", responseFailure.isError && responseFailure.details.status === "failed" && responseFailureTask.status === "failed" && responseFailureHerdr.calls.at(-1)[0] === "closeTab");
	const siblingFailureHerdr = fakeHerdr("blocked-then-post-fail");
	const siblingFailureRun = await executeHerdrSubagents({ concurrency: 1, tasks: [{ name: "response-fails", prompt: "question", agent: "explorer" }, { name: "queued-sibling", prompt: "later", agent: "reviewer" }] }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: siblingFailureHerdr });
	await executeHerdrSubagents({ action: "respond", runId: siblingFailureRun.details.runId, answer: "main" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: siblingFailureHerdr });
	const siblingFailureTasks = readdirSync(join(siblingFailureRun.details.recordDirectory, "tasks")).map((entry) => JSON.parse(readFileSync(join(siblingFailureRun.details.recordDirectory, "tasks", entry, "task.json"), "utf8")));
	check("failed blocked response releases its slot and continues queued siblings", siblingFailureTasks.every((task) => ["failed", "completed"].includes(task.status)) && siblingFailureTasks.every((task) => task.status !== "cancelled") && siblingFailureHerdr.calls.filter(([name]) => name === "promptAgent").length === 3);
	const abortedContinuationHerdr = fakeHerdr("blocked");
	const abortedContinuationRun = await executeHerdrSubagents({ concurrency: 1, tasks: [{ name: "already-done", prompt: "question", agent: "explorer" }, { name: "cancel-me", prompt: "later", agent: "reviewer" }] }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: abortedContinuationHerdr });
	const abortedTaskDirectories = readdirSync(join(abortedContinuationRun.details.recordDirectory, "tasks")).sort().map((entry) => join(abortedContinuationRun.details.recordDirectory, "tasks", entry));
	const firstAbortedTask = JSON.parse(readFileSync(join(abortedTaskDirectories[0], "task.json"), "utf8"));
	writeFileSync(join(abortedTaskDirectories[0], "task.json"), JSON.stringify({ ...firstAbortedTask, status: "completed" }));
	const continuationAbort = new AbortController();
	continuationAbort.abort(new Error("Parent Pi session closed."));
	abortedContinuationHerdr.promptAgent = async () => { throw new Error("Parent Pi session closed."); };
	await continueQueuedRun(abortedContinuationRun.details.recordDirectory, abortedContinuationHerdr, { cleanup: false, signal: continuationAbort.signal });
	const cancelledContinuationTask = JSON.parse(readFileSync(join(abortedTaskDirectories[1], "task.json"), "utf8"));
	const cancelledContinuationRun = JSON.parse(readFileSync(join(abortedContinuationRun.details.recordDirectory, "run.json"), "utf8"));
	const cancelledContinuationReport = JSON.parse(readFileSync(join(abortedTaskDirectories[1], "report.json"), "utf8"));
	check("aborted queued continuation is persisted as cancelled", cancelledContinuationTask.status === "cancelled" && cancelledContinuationRun.status === "cancelled" && cancelledContinuationReport.summary.includes("cancelled"));
	const deadPaneHerdr = fakeHerdr("blocked");
	const deadPaneRun = await executeHerdrSubagents({ tasks: [{ name: "dead-pane", prompt: "question", agent: "explorer" }] }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: deadPaneHerdr });
	deadPaneHerdr.paneExists = async () => false;
	const deadPaneResume = await executeHerdrSubagents({ action: "respond", runId: deadPaneRun.details.runId, answer: "main" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: deadPaneHerdr });
	const deadPaneTaskDirectory = join(deadPaneRun.details.recordDirectory, "tasks", readdirSync(join(deadPaneRun.details.recordDirectory, "tasks"))[0]);
	const deadPaneTask = JSON.parse(readFileSync(join(deadPaneTaskDirectory, "task.json"), "utf8"));
	check("dead blocked pane recovers a coherent attempt with its persona prompt", !deadPaneResume.isError && deadPaneHerdr.calls.filter(([name]) => name === "createTab").length === 2 && deadPaneTask.tabId === "w1:t2" && deadPaneTask.attempt === 2 && deadPaneTask.currentTurnFile.endsWith("02.json") && existsSync(deadPaneTask.currentTurnFile) && readFileSync(join(deadPaneTaskDirectory, "resume-system-prompt.md"), "utf8").includes("Investigate the assigned question without modifying files"));
	const staleTabHerdr = fakeHerdr("blocked");
	const staleTabRun = await executeHerdrSubagents({ tasks: [{ name: "stale-tab", prompt: "question", agent: "explorer" }] }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: staleTabHerdr });
	staleTabHerdr.paneExists = async () => false;
	staleTabHerdr.createTab = async (request) => { staleTabHerdr.calls.push(["createTab", request]); return { tabId: "w1:t-new", paneId: "w1:p-new" }; };
	staleTabHerdr.closeTab = async (tabId) => { staleTabHerdr.calls.push(["closeTab", { tabId }]); if (tabId === "w1:t2") throw new Error("stale tab still busy"); };
	const staleTabUpdates = [];
	const staleTabResume = await executeHerdrSubagents({ action: "respond", runId: staleTabRun.details.runId, answer: "main" }, undefined, (update) => staleTabUpdates.push(update), { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: staleTabHerdr });
	const staleTabRecord = JSON.parse(readFileSync(join(staleTabRun.details.recordDirectory, "run.json"), "utf8"));
	check("dead-pane migration persists and surfaces stale tab cleanup failure", !staleTabResume.isError && staleTabRecord.cleanupError === "stale tab still busy" && staleTabRecord.staleTabIds?.includes("w1:t2") && staleTabUpdates.some((update) => update.content[0].text.includes("Could not close stale Herdr tab")));
	const invalidTurnHerdr = fakeHerdr("blocked");
	const invalidTurnRun = await executeHerdrSubagents({ tasks: [{ name: "invalid-turn", prompt: "question", agent: "explorer" }] }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: invalidTurnHerdr });
	const invalidTurnTaskDirectory = join(invalidTurnRun.details.recordDirectory, "tasks", readdirSync(join(invalidTurnRun.details.recordDirectory, "tasks"))[0]);
	const invalidTurnTaskFile = join(invalidTurnTaskDirectory, "task.json");
	const invalidTurnTask = JSON.parse(readFileSync(invalidTurnTaskFile, "utf8"));
	const invalidTurnFile = join(invalidTurnTaskDirectory, "turns", "01.json");
	mkdirSync(join(invalidTurnTaskDirectory, "turns"), { recursive: true });
	writeFileSync(invalidTurnFile, "{truncated");
	invalidTurnTask.currentTurnFile = invalidTurnFile;
	writeFileSync(invalidTurnTaskFile, JSON.stringify(invalidTurnTask));
	const invalidTurnUpdates = [];
	await executeHerdrSubagents({ action: "respond", runId: invalidTurnRun.details.runId, answer: "main" }, undefined, (update) => invalidTurnUpdates.push(update), { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: invalidTurnHerdr });
	check("invalid durable turn is archived and surfaced before recovery", readdirSync(join(invalidTurnTaskDirectory, "turns")).some((name) => name.startsWith("01.json.invalid-")) && invalidTurnUpdates.some((update) => update.content[0].text.includes("Archived invalid durable turn")));
	const corruptLookupRoot = join(root, "corrupt-run-lookup");
	mkdirSync(join(corruptLookupRoot, ".pi", "herdr-subagents", "runs", "bad"), { recursive: true });
	writeFileSync(join(corruptLookupRoot, ".pi", "herdr-subagents", "runs", "bad", "run.json"), "{truncated");
	const corruptLookup = await executeHerdrSubagents({ action: "respond", runId: "missing", answer: "main" }, undefined, undefined, { cwd: corruptLookupRoot }, { agentsDirectory: join(process.cwd(), "agents"), herdr: fakeHerdr() });
	check("blocked response surfaces unreadable run records instead of reporting unknown", corruptLookup.isError && corruptLookup.content[0].text.includes("Could not inspect Subagent runs"));
	const survivingPaneRunFile = join(root, "surviving-pane-run.json");
	const survivingPaneRun = { id: "surviving-pane", label: "surviving-pane", status: "blocked", cwd: root, tabId: "w1:t-surviving", paneIds: ["w1:p-live", "w1:p-dead"] };
	writeFileSync(survivingPaneRunFile, JSON.stringify(survivingPaneRun));
	const survivingPaneHerdr = fakeHerdr();
	survivingPaneHerdr.paneExists = async (paneId) => paneId === "w1:p-live";
	const survivingPaneAllocator = new RunPaneAllocator({ herdr: survivingPaneHerdr, run: survivingPaneRun, runFile: survivingPaneRunFile, validateExistingPane: true });
	await survivingPaneAllocator.allocate(root);
	check("missing allocation anchor preserves and splits a surviving sibling pane", survivingPaneHerdr.calls.some(([name, request]) => name === "splitPane" && request.paneId === "w1:p-live") && !survivingPaneHerdr.calls.some(([name]) => name === "createTab" || name === "closeTab") && survivingPaneRun.paneIds[0] === "w1:p-live" && survivingPaneRun.paneIds.length === 2);
	const multiStaleRoot = join(root, "multi-stale-recovery");
	const multiStaleDirectory = join(multiStaleRoot, ".pi", "herdr-subagents", "runs", "multi-stale");
	mkdirSync(multiStaleDirectory, { recursive: true });
	const multiStaleRunFile = join(multiStaleDirectory, "run.json");
	const multiStaleRun = { id: "multi-stale", label: "multi-stale", status: "blocked", cwd: multiStaleRoot, tabId: "w1:t-old-a", paneIds: ["w1:p-dead-a"] };
	writeFileSync(multiStaleRunFile, JSON.stringify(multiStaleRun));
	const multiStaleHerdr = fakeHerdr();
	multiStaleHerdr.paneExists = async () => false;
	let replacementNumber = 0;
	multiStaleHerdr.createTab = async (request) => { multiStaleHerdr.calls.push(["createTab", request]); replacementNumber += 1; return { tabId: `w1:t-new-${replacementNumber}`, paneId: `w1:p-new-${replacementNumber}` }; };
	multiStaleHerdr.closeTab = async (tabId) => { multiStaleHerdr.calls.push(["closeTab", { tabId }]); throw new Error(`cannot close ${tabId}`); };
	const multiStaleErrors = [];
	const multiStaleAllocator = new RunPaneAllocator({ herdr: multiStaleHerdr, run: multiStaleRun, runFile: multiStaleRunFile, validateExistingPane: true, onCleanupError: (message) => multiStaleErrors.push(message) });
	await multiStaleAllocator.allocate(multiStaleRoot);
	await multiStaleAllocator.allocate(multiStaleRoot);
	const pendingMultiStale = JSON.parse(readFileSync(multiStaleRunFile, "utf8"));
	pendingMultiStale.status = "completed";
	writeFileSync(multiStaleRunFile, JSON.stringify(pendingMultiStale));
	check("successive stale-tab cleanup failures remain visible and durable", multiStaleErrors.length === 2 && ["w1:t-old-a", "w1:t-new-1"].every((tabId) => pendingMultiStale.cleanupPendingTabIds?.includes(tabId)));
	const multiStaleRecoveryHerdr = fakeHerdr();
	await reconcileSubagentRuns(multiStaleRoot, multiStaleRecoveryHerdr);
	const recoveredMultiStale = JSON.parse(readFileSync(multiStaleRunFile, "utf8"));
	const recoveredTabIds = multiStaleRecoveryHerdr.calls.filter(([name]) => name === "closeTab").map(([, request]) => request.tabId);
	check("startup reconciliation retries every pending stale tab", ["w1:t-old-a", "w1:t-new-1"].every((tabId) => recoveredTabIds.includes(tabId)) && !("cleanupPendingTabIds" in recoveredMultiStale));

	const history = await listSubagentHistory(root);
	const stableHistory = history.find((run) => run.id === backgroundId);
	check("history lists compact project-local runs and tasks", Boolean(stableHistory?.tasks.length) && historyText(history).includes("stable") && !historyText(history).includes("FULL stable"));
	const historyHerdr = fakeHerdr();
	const historicalUpdates = [];
	const historicalResume = await executeHerdrSubagents({ action: "resume", runId: backgroundId, task: 1, prompt: "follow up" }, undefined, (update) => historicalUpdates.push(update.details), { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: historyHerdr });
	const historyStartRequest = historyHerdr.calls.find(([name]) => name === "startAgent")[1];
	check("historical resume preserves the saved Pi session and persona prompt", !historicalResume.isError && historyHerdr.calls[0][0] === "createTab" && historyStartRequest.args.includes(stableHistory.tasks[0].sessionFile) && historyStartRequest.args.includes(stableHistory.tasks[0].model) && historyStartRequest.args.some((value) => String(value).includes("subagent_report")) && existsSync(join(stableHistory.tasks[0].recordDirectory, "turns", "02.json")) && readFileSync(join(stableHistory.tasks[0].recordDirectory, "followup-system-prompt.md"), "utf8").includes("Investigate the assigned question without modifying files"));
	check("historical resume streams authoritative Fleet activity", historicalUpdates.some((update) => update.status === "running" && update.activity?.[0]?.agent === "explorer" && update.activity[0].sessionFile === stableHistory.tasks[0].sessionFile));
	const historicalTaskRecord = JSON.parse(readFileSync(join(stableHistory.tasks[0].recordDirectory, "task.json"), "utf8"));
	const historicalTurnRecord = JSON.parse(readFileSync(join(stableHistory.tasks[0].recordDirectory, "turns", "02.json"), "utf8"));
	check("historical task and turn retain their tab identity", historicalTaskRecord.tabId === historicalResume.details.tabId && historicalTurnRecord.tabId === historicalResume.details.tabId);
	const resumeRaceRoot = join(root, "resume-race");
	const resumeRaceSeed = await runHerdrSubagents("original", { cwd: resumeRaceRoot, herdr: fakeHerdr() });
	const resumeRaceHerdr = fakeHerdr();
	const createRaceTab = resumeRaceHerdr.createTab.bind(resumeRaceHerdr);
	let beginFirstCreate;
	const firstCreateStarted = new Promise((resolve) => { beginFirstCreate = resolve; });
	let releaseFirstCreate;
	const firstCreateGate = new Promise((resolve) => { releaseFirstCreate = resolve; });
	let raceCreates = 0;
	resumeRaceHerdr.createTab = async (request) => {
		raceCreates += 1;
		if (raceCreates === 1) { beginFirstCreate(); await firstCreateGate; }
		return createRaceTab(request);
	};
	const firstResume = executeHerdrSubagents({ action: "resume", runId: resumeRaceSeed.runId, task: 1, prompt: "first" }, undefined, undefined, { cwd: resumeRaceRoot }, { agentsDirectory: join(process.cwd(), "agents"), herdr: resumeRaceHerdr });
	await firstCreateStarted;
	const competingResume = await executeHerdrSubagents({ action: "resume", runId: resumeRaceSeed.runId, task: 1, prompt: "second" }, undefined, undefined, { cwd: resumeRaceRoot }, { agentsDirectory: join(process.cwd(), "agents"), herdr: resumeRaceHerdr });
	releaseFirstCreate();
	await firstResume;
	check("concurrent historical resume cannot start a second Pi session writer", competingResume.isError && raceCreates === 1 && resumeRaceHerdr.calls.filter(([name]) => name === "startAgent").length === 1);
	check("historical resume releases the run lock after settlement", !existsSync(join(resumeRaceSeed.recordDirectory, ".resume.lock")));
	const partialResumeHerdr = fakeHerdr();
	const partialResumeTaskFile = join((await listSubagentHistory(root)).find((run) => run.id === failedAfterBlock.details.runId).tasks[0].recordDirectory, "task.json");
	const stalePartialTask = JSON.parse(readFileSync(partialResumeTaskFile, "utf8"));
	Object.assign(stalePartialTask, { error: "stale failure", question: "stale question" });
	writeFileSync(partialResumeTaskFile, JSON.stringify(stalePartialTask));
	await executeHerdrSubagents({ action: "resume", runId: failedAfterBlock.details.runId, task: 1, prompt: "follow up completed task" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: partialResumeHerdr });
	const partialResumeRun = JSON.parse(readFileSync(join(failedAfterBlock.details.recordDirectory, "run.json"), "utf8"));
	check("historical follow-up preserves partial batch aggregation", partialResumeRun.status === "partial");
	const partialResumeTask = JSON.parse(readFileSync(partialResumeTaskFile, "utf8"));
	check("historical follow-up clears stale failure fields", partialResumeTask.status === "completed" && !("error" in partialResumeTask) && !("question" in partialResumeTask));
	const historicalCancellationHerdr = fakeHerdr();
	historicalCancellationHerdr.promptAgent = async (request) => await new Promise((resolve, reject) => {
		if (request.signal?.aborted) reject(request.signal.reason);
		else request.signal?.addEventListener("abort", () => reject(request.signal.reason), { once: true });
	});
	const historicalCancellationController = new AbortController();
	const historicalCancellationPromise = executeHerdrSubagents({ action: "resume", runId: failedAfterBlock.details.runId, task: 1, prompt: "cancel this follow-up" }, historicalCancellationController.signal, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: historicalCancellationHerdr });
	await new Promise((resolve) => setTimeout(resolve, 5));
	historicalCancellationController.abort(new Error("Parent Pi session closed."));
	await historicalCancellationPromise;
	const historicalCancelledRun = JSON.parse(readFileSync(join(failedAfterBlock.details.recordDirectory, "run.json"), "utf8"));
	check("parent shutdown marks a historical follow-up run cancelled despite completed siblings", historicalCancelledRun.status === "cancelled" && historicalCancelledRun.error.includes("Parent Pi session closed"));
	const followupBlockedHerdr = fakeHerdr("blocked");
	const blockedFollowup = await executeHerdrSubagents({ action: "resume", runId: backgroundId, task: 1, prompt: "ask a follow-up" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: followupBlockedHerdr });
	const duplicateResumeHerdr = fakeHerdr();
	const duplicateResume = await executeHerdrSubagents({ action: "resume", runId: backgroundId, task: 1, prompt: "duplicate live follow-up" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: duplicateResumeHerdr });
	check("historical resume rejects an active run without starting a second Agent", duplicateResume.isError && duplicateResume.content[0].text.includes("still active") && duplicateResumeHerdr.calls.length === 0);
	const answeredFollowup = await executeHerdrSubagents({ action: "respond", runId: backgroundId, answer: "follow-up answer" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: followupBlockedHerdr });
	const historicalTurns = join(stableHistory.tasks[0].recordDirectory, "turns");
	const answeredTurn = JSON.parse(readFileSync(join(historicalTurns, "03.json"), "utf8"));
	check("blocked historical follow-up remains publicly resumable with durable turns", blockedFollowup.details.status === "blocked" && !answeredFollowup.isError && answeredFollowup.details.status === "completed" && existsSync(join(historicalTurns, "01.json")) && answeredTurn.status === "completed" && answeredTurn.events.some((event) => event.type === "answer"));
	const prePromptFailureTaskFile = join(stableHistory.tasks[0].recordDirectory, "task.json");
	const prePromptStaleTask = JSON.parse(readFileSync(prePromptFailureTaskFile, "utf8"));
	Object.assign(prePromptStaleTask, { question: "stale question", error: "stale error", completedAt: "2000-01-01T00:00:00.000Z" });
	writeFileSync(prePromptFailureTaskFile, JSON.stringify(prePromptStaleTask));
	const prePromptFailureHerdr = fakeHerdr();
	prePromptFailureHerdr.startAgent = async () => { throw new Error("historical startup failed"); };
	const prePromptFailure = await executeHerdrSubagents({ action: "resume", runId: backgroundId, task: 1, prompt: "cannot start" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: prePromptFailureHerdr });
	const prePromptFailedTask = JSON.parse(readFileSync(prePromptFailureTaskFile, "utf8"));
	const prePromptFailureReport = JSON.parse(readFileSync(join(stableHistory.tasks[0].recordDirectory, "report.json"), "utf8"));
	check("historical pre-prompt failure replaces stale state and report", prePromptFailure.isError && prePromptFailedTask.status === "failed" && !("question" in prePromptFailedTask) && prePromptFailedTask.error.includes("historical startup failed") && prePromptFailedTask.completedAt !== "2000-01-01T00:00:00.000Z" && prePromptFailureReport.status === "failed" && prePromptFailureReport.error.includes("historical startup failed"));
	check("historical resume releases the run lock after failure", !existsSync(join(stableHistory.recordDirectory, ".resume.lock")));
	const postPromptFailureHerdr = fakeHerdr("post-fail");
	const postPromptFailureUpdates = [];
	const postPromptFailure = await executeHerdrSubagents({ action: "resume", runId: backgroundId, task: 1, prompt: "fails after submit" }, undefined, (update) => postPromptFailureUpdates.push(update.details), { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: postPromptFailureHerdr });
	const postPromptFailureReport = JSON.parse(readFileSync(join(stableHistory.tasks[0].recordDirectory, "report.json"), "utf8"));
	check("historical post-prompt failure persists its authoritative report", postPromptFailure.isError && postPromptFailureReport.status === "failed" && postPromptFailureReport.error.includes("connection lost after prompt submission"));
	check("historical resume failure emits terminal Fleet activity", postPromptFailureUpdates.some((update) => update.status === "running") && postPromptFailureUpdates.at(-1).status === "failed" && postPromptFailureUpdates.at(-1).activity.every((task) => task.status !== "running"));
	const shutdownBlockedHerdr = fakeHerdr("blocked");
	const shutdownBlocked = await executeHerdrSubagents({ tasks: [{ name: "blocked-at-shutdown", prompt: "need input", agent: "explorer" }] }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: shutdownBlockedHerdr });
	await cancelActiveSubagentRuns(root, shutdownBlockedHerdr);
	const shutdownBlockedRecord = JSON.parse(readFileSync(join(shutdownBlocked.details.recordDirectory, "run.json"), "utf8"));
	check("parent shutdown cancels blocked work and closes its tab", shutdownBlockedRecord.status === "cancelled" && shutdownBlockedHerdr.calls.at(-1)[0] === "closeTab");
	const ignoreFile = join(root, ".pi", ".gitignore");
	writeFileSync(ignoreFile, `${readFileSync(ignoreFile, "utf8")}unrelated-state/\n`);
	await ensureRuntimeIgnored(root);
	const ignoreText = readFileSync(ignoreFile, "utf8");
	check("runtime archive is ignored without hiding personas or overwriting unrelated rules", ignoreText.includes("herdr-subagents/runs/") && !ignoreText.split(/\r?\n/).includes("herdr-subagents/") && ignoreText.includes("unrelated-state/") && ignoreText.match(/herdr-subagents\/runs\//g)?.length === 1);
	const remainingRunId = history.find((run) => run.id !== backgroundId)?.id;
	const cleaned = await executeHerdrSubagents({ action: "cleanup", runId: backgroundId }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: fakeHerdr() });
	const afterCleanup = await listSubagentHistory(root);
	check("explicit cleanup removes only the selected run", !cleaned.isError && !afterCleanup.some((run) => run.id === backgroundId) && (!remainingRunId || afterCleanup.some((run) => run.id === remainingRunId)));

	const retryHerdr = fakeHerdr();
	const createTab = retryHerdr.createTab.bind(retryHerdr);
	let createAttempts = 0;
	retryHerdr.createTab = async (request) => { createAttempts += 1; if (createAttempts === 1) { await createTab(request); throw new Error("tab created but response lost"); } return await createTab(request); };
	const retried = await executeHerdrSubagents({ tasks: [{ name: "retry", prompt: "retry", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: retryHerdr });
	check("uncertain tab creation is not retried", retried.isError && createAttempts === 1 && retryHerdr.calls.filter(([name]) => name === "promptAgent").length === 0);
	const splitFailureRoot = join(root, "split-failure");
	const splitFailureHerdr = fakeHerdr();
	let splitAttempts = 0;
	splitFailureHerdr.splitPane = async () => { splitAttempts += 1; throw new Error("split committed but response lost"); };
	const splitFailure = await executeHerdrSubagents({ concurrency: 1, tasks: [{ name: "first", prompt: "first", agent: "explorer" }, { name: "second", prompt: "second", agent: "reviewer" }] }, undefined, undefined, { cwd: splitFailureRoot }, { agentsDirectory: join(process.cwd(), "agents"), herdr: splitFailureHerdr });
	check("uncertain pane split is not retried", splitFailure.isError && splitAttempts === 1);
	const permanentStartupHerdr = fakeHerdr();
	let permanentAttempts = 0;
	permanentStartupHerdr.createTab = async () => { permanentAttempts += 1; throw new Error("permanent startup failure"); };
	const permanentStartup = await executeHerdrSubagents({ label: "permanent-startup", tasks: [{ name: "never-started", prompt: "never", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: permanentStartupHerdr });
	const permanentHistory = (await listSubagentHistory(root)).find((run) => run.label === "permanent-startup");
	check("tab creation failure persists failed run", permanentStartup.isError && permanentAttempts === 1 && permanentHistory?.status === "failed" && permanentHistory.tasks.every((task) => task.status === "failed"));
	const startRetryHerdr = fakeHerdr();
	const originalStart = startRetryHerdr.startAgent.bind(startRetryHerdr);
	let startAttempts = 0;
	startRetryHerdr.startAgent = async (request) => { startAttempts += 1; await originalStart(request); if (startAttempts === 1) throw new Error("Agent started but response lost"); };
	const startRetryRun = await executeHerdrSubagents({ tasks: [{ name: "start-retry", prompt: "start retry", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: startRetryHerdr });
	check("uncertain Agent startup is not retried", startRetryRun.isError && startAttempts === 1 && startRetryHerdr.calls.filter(([name]) => name === "promptAgent").length === 0);
	const failedStartHerdr = fakeHerdr();
	let failedStartAttempts = 0;
	failedStartHerdr.startAgent = async () => { failedStartAttempts += 1; throw new Error("permanent child startup failure"); };
	const failedStartRun = await executeHerdrSubagents({ concurrency: 2, tasks: [{ name: "first", prompt: "first", agent: "explorer" }, { name: "second", prompt: "second", agent: "reviewer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: failedStartHerdr });
	check("failed Agent startup releases other workers", failedStartRun.isError && failedStartAttempts === 2 && failedStartRun.details.tasks.every((task) => task.status === "failed"));
	const postFailureHerdr = fakeHerdr("post-fail");
	const postFailure = await executeHerdrSubagents({ tasks: [{ name: "no-retry", prompt: "side effect", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: postFailureHerdr });
	check("failure after prompt submission is preserved without rerun", postFailure.isError && postFailureHerdr.calls.filter(([name]) => name === "promptAgent").length === 1 && postFailure.details.tasks[0].error.includes("after prompt"));
	const authoritativeAfterPromptFailure = await executeHerdrSubagents({ tasks: [{ name: "authoritative", prompt: "finish then disconnect", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: fakeHerdr("report-then-post-fail") });
	const authoritativeTaskDirectory = join(authoritativeAfterPromptFailure.details.recordDirectory, "tasks", readdirSync(join(authoritativeAfterPromptFailure.details.recordDirectory, "tasks"))[0]);
	const authoritativeTask = JSON.parse(readFileSync(join(authoritativeTaskDirectory, "task.json"), "utf8"));
	const authoritativeReport = JSON.parse(readFileSync(join(authoritativeTaskDirectory, "report.json"), "utf8"));
	check("valid persisted report remains authoritative after Herdr prompt transport failure", !authoritativeAfterPromptFailure.isError && authoritativeTask.status === "completed" && authoritativeReport.status === "completed" && authoritativeAfterPromptFailure.details.tasks[0].summary === authoritativeReport.summary);
	check("production batch path never passes print mode", batchStarts.every((request) => !request.args.includes("--print")));
	check("production batch path never steals pane focus", !batchHerdr.calls.some(([name]) => name === "focusPane"));

	const atomicFile = join(root, "atomic.json");
	await Promise.all(Array.from({ length: 12 }, (_, index) => writeJsonAtomic(atomicFile, { index, payload: "x".repeat(1000) })));
	const atomicValue = JSON.parse(readFileSync(atomicFile, "utf8"));
	check("atomic snapshots remain parseable under replacement", Number.isInteger(atomicValue.index) && !readdirSync(root).some((entry) => entry.startsWith("atomic.json.tmp-")));
	await persistQueuedRun(root, "queued-persisted", { runId: "queued-persisted", background: true, tasks: [{ name: "later", prompt: "later", agent: "explorer" }] });
	check("queued background submission survives parent shutdown", (await loadQueuedRuns(root)).some((run) => run.runId === "queued-persisted"));
	await cancelQueuedRuns(root, ["queued-persisted"]);
	const cancelledQueued = (await listSubagentHistory(root)).find((run) => run.id === "queued-persisted");
	check("parent shutdown archives queued work as cancelled", !(await loadQueuedRuns(root)).some((run) => run.runId === "queued-persisted") && cancelledQueued?.status === "cancelled" && cancelledQueued.tasks[0].status === "cancelled");
	await persistQueuedRun(root, "live-foreign-queue", { background: true, tasks: [{ name: "foreign", prompt: "foreign" }] }, { sessionId: "foreign-owner", processId: process.pid });
	await cancelQueuedRuns(root, ["live-foreign-queue"], { reason: "orphan cleanup", onlyOrphaned: true });
	check("startup leaves another live parent process queue untouched", (await loadQueuedRuns(root)).some((run) => run.runId === "live-foreign-queue"));
	await persistQueuedRun(root, "stale-same-process-queue", { background: true, tasks: [{ name: "stale", prompt: "stale" }] }, { sessionId: "old-session", processId: process.pid });
	await cancelQueuedRuns(root, ["stale-same-process-queue"], { reason: "orphan cleanup", owner: { sessionId: "new-session", processId: process.pid }, onlyOrphaned: true });
	check("startup cancels a prior session queue owned by the same process", !(await loadQueuedRuns(root)).some((run) => run.runId === "stale-same-process-queue") && (await listSubagentHistory(root)).some((run) => run.id === "stale-same-process-queue" && run.status === "cancelled"));
	const malformedQueueDirectory = join(root, "malformed-queue", ".pi", "herdr-subagents", "queue");
	mkdirSync(malformedQueueDirectory, { recursive: true });
	writeFileSync(join(malformedQueueDirectory, "broken.json"), "{truncated");
	let malformedQueueError = "";
	try { await loadQueuedRuns(join(root, "malformed-queue")); } catch (error) { malformedQueueError = error.message; }
	check("malformed queued records fail visibly", malformedQueueError.includes("Could not read queued Subagent run") && malformedQueueError.includes("broken.json"));
	const isolatedQueueErrors = [];
	const isolatedQueueRecords = await loadQueuedRuns(join(root, "malformed-queue"), (message) => isolatedQueueErrors.push(message));
	check("startup queue inspection isolates malformed records", isolatedQueueRecords.length === 0 && isolatedQueueErrors.some((message) => message.includes("broken.json")));
	const ownershipRoot = join(root, "ownership");
	for (const [suffix, owner] of [["a", "owner-a"], ["b", "owner-b"]]) {
		const directory = join(ownershipRoot, ".pi", "herdr-subagents", "runs", suffix);
		const taskDirectory = join(directory, "tasks", "01-task");
		mkdirSync(taskDirectory, { recursive: true });
		writeFileSync(join(directory, "run.json"), JSON.stringify({ id: `run-${suffix}`, label: suffix, status: "blocked", cwd: ownershipRoot, ownerSessionId: owner, ownerProcessId: process.pid, tabId: `w1:t${suffix}`, taskIds: [`task-${suffix}`] }));
		writeFileSync(join(taskDirectory, "task.json"), JSON.stringify({ id: `task-${suffix}`, runId: `run-${suffix}`, order: 1, name: suffix, status: "blocked", sessionFile: join(taskDirectory, "session.jsonl") }));
	}
	const ownershipHerdr = fakeHerdr();
	await cancelActiveSubagentRuns(ownershipRoot, ownershipHerdr, { reason: "shutdown", owner: { sessionId: "owner-a" } });
	check("graceful shutdown cancels only runs owned by that parent session", JSON.parse(readFileSync(join(ownershipRoot, ".pi", "herdr-subagents", "runs", "a", "run.json"), "utf8")).status === "cancelled" && JSON.parse(readFileSync(join(ownershipRoot, ".pi", "herdr-subagents", "runs", "b", "run.json"), "utf8")).status === "blocked");
	await reconcileSubagentRuns(ownershipRoot, ownershipHerdr, { sessionId: "new-owner", processId: process.pid + 1 });
	check("startup reconciliation leaves another live parent process untouched", JSON.parse(readFileSync(join(ownershipRoot, ".pi", "herdr-subagents", "runs", "b", "run.json"), "utf8")).status === "blocked");
	const pendingRecoveryRoot = join(root, "pending-cleanup-recovery");
	const pendingRecoveryRun = join(pendingRecoveryRoot, ".pi", "herdr-subagents", "runs", "run");
	mkdirSync(pendingRecoveryRun, { recursive: true });
	writeFileSync(join(pendingRecoveryRun, "run.json"), JSON.stringify({ id: "pending-recovery", label: "pending-recovery", status: "completed", cwd: pendingRecoveryRoot, ownerSessionId: "stale-owner", ownerProcessId: 99999999, tabId: "w1:t-pending", cleanupPendingTabIds: ["w1:t-pending"] }));
	const pendingRecoveryHerdr = fakeHerdr();
	await reconcileSubagentRuns(pendingRecoveryRoot, pendingRecoveryHerdr, { sessionId: "new-owner", processId: process.pid });
	const recoveredPendingRun = JSON.parse(readFileSync(join(pendingRecoveryRun, "run.json"), "utf8"));
	check("startup reconciliation finishes stale terminal deferred cleanup", pendingRecoveryHerdr.calls.some(([name, request]) => name === "closeTab" && request.tabId === "w1:t-pending") && !("cleanupPendingTabIds" in recoveredPendingRun));
	const failedRecoveryRoot = join(root, "failed-cleanup-recovery");
	const failedRecoveryRun = join(failedRecoveryRoot, ".pi", "herdr-subagents", "runs", "run");
	mkdirSync(failedRecoveryRun, { recursive: true });
	writeFileSync(join(failedRecoveryRun, "run.json"), JSON.stringify({ id: "failed-recovery", label: "failed-recovery", status: "running", cwd: failedRecoveryRoot, ownerSessionId: "stale-owner", ownerProcessId: 99999999, tabId: "w1:t-failed" }));
	await reconcileSubagentRuns(failedRecoveryRoot, fakeHerdr("close-failed"), { sessionId: "new-owner", processId: process.pid });
	const failedRecoveryPending = JSON.parse(readFileSync(join(failedRecoveryRun, "run.json"), "utf8"));
	await reconcileSubagentRuns(failedRecoveryRoot, fakeHerdr(), { sessionId: "new-owner", processId: process.pid });
	const retriedRecovery = JSON.parse(readFileSync(join(failedRecoveryRun, "run.json"), "utf8"));
	check("reconciliation cleanup failure is durable and retried on startup", failedRecoveryPending.status === "failed" && failedRecoveryPending.cleanupPendingTabIds?.includes("w1:t-failed") && !("cleanupPendingTabIds" in retriedRecovery));

	const recoveryRoot = join(root, "recovery");
	const recoveryTask = join(recoveryRoot, ".pi", "herdr-subagents", "runs", "run", "tasks", "01-task");
	mkdirSync(recoveryTask, { recursive: true });
	writeFileSync(join(recoveryRoot, ".pi", "herdr-subagents", "runs", "run", "run.json"), JSON.stringify({ id: "recover", label: "recover", status: "running", startedAt: new Date().toISOString() }));
	writeFileSync(join(recoveryTask, "task.json"), JSON.stringify({ id: "task", runId: "recover", order: 1, name: "lost", status: "running", paneId: "w1:missing", sessionFile: join(recoveryTask, "session.jsonl") }));
	const reconciliation = await reconcileSubagentRuns(recoveryRoot, fakeHerdr("missing-pane"), { sessionId: "new-owner" });
	check("reconciliation marks stale child cancelled", reconciliation.cancelledTasks === 1 && JSON.parse(readFileSync(join(recoveryTask, "task.json"), "utf8")).status === "cancelled");
	const malformedRoot = join(root, "malformed-recovery");
	const malformedRun = join(malformedRoot, ".pi", "herdr-subagents", "runs", "run");
	const malformedTask = join(malformedRun, "tasks", "01-task");
	mkdirSync(malformedTask, { recursive: true });
	writeFileSync(join(malformedRun, "run.json"), JSON.stringify({ id: "malformed", label: "malformed", status: "running", cwd: malformedRoot, ownerSessionId: "dead-owner", ownerProcessId: 99999999, tabId: "w1:t-malformed" }));
	writeFileSync(join(malformedTask, "task.json"), JSON.stringify({ id: "malformed-task", runId: "malformed", order: 1, name: "malformed", status: "running", paneId: "w1:p-malformed", sessionFile: join(malformedTask, "session.jsonl") }));
	writeFileSync(join(malformedTask, "report.json"), "{truncated");
	const malformedHerdr = fakeHerdr();
	const malformedReconciliation = await reconcileSubagentRuns(malformedRoot, malformedHerdr, { sessionId: "new-owner", processId: process.pid });
	check("malformed report cannot abort orphan reconciliation", malformedReconciliation.cancelledTasks === 1 && malformedReconciliation.cleanupErrors.some((message) => message.includes("Invalid Subagent report")) && JSON.parse(readFileSync(join(malformedTask, "task.json"), "utf8")).status === "cancelled" && malformedHerdr.calls.some(([name]) => name === "closeTab"));
	const invalidReportRoot = join(root, "invalid-report-recovery");
	const invalidReportRun = join(invalidReportRoot, ".pi", "herdr-subagents", "runs", "run");
	const invalidReportTask = join(invalidReportRun, "tasks", "01-task");
	mkdirSync(invalidReportTask, { recursive: true });
	writeFileSync(join(invalidReportRun, "run.json"), JSON.stringify({ id: "invalid-report", label: "invalid-report", status: "running", startedAt: new Date().toISOString() }));
	writeFileSync(join(invalidReportTask, "task.json"), JSON.stringify({ id: "invalid-report-task", runId: "invalid-report", order: 1, status: "running", paneId: "w1:p-invalid", sessionFile: join(invalidReportTask, "session.jsonl") }));
	writeFileSync(join(invalidReportTask, "report.json"), JSON.stringify({ status: "garbage" }));
	const invalidReportReconciliation = await reconcileSubagentRuns(invalidReportRoot, fakeHerdr());
	const invalidReportTaskRecord = JSON.parse(readFileSync(join(invalidReportTask, "task.json"), "utf8"));
	check("semantically invalid reports recover as explicit failures", invalidReportTaskRecord.status === "failed" && invalidReportTaskRecord.error.includes("Invalid structured report") && invalidReportReconciliation.cleanupErrors.some((message) => message.includes("Invalid report status")));
	const repairedRecoveryReport = JSON.parse(readFileSync(join(invalidReportTask, "report.json"), "utf8"));
	const unrelatedBrokenHistory = join(invalidReportRoot, ".pi", "herdr-subagents", "runs", "broken-history");
	mkdirSync(unrelatedBrokenHistory, { recursive: true });
	writeFileSync(join(unrelatedBrokenHistory, "run.json"), "{truncated");
	const repairedRecoveryHistory = await listSubagentHistory(invalidReportRoot);
	check("recovered malformed report remains usable in history", repairedRecoveryReport.status === "failed" && readdirSync(invalidReportTask).some((entry) => entry.startsWith("report.json.invalid-")) && repairedRecoveryHistory.some((run) => run.id === "invalid-report" && run.tasks[0].status === "failed"));
	check("unreadable history entries do not hide healthy completed records", repairedRecoveryHistory.some((run) => run.id === "invalid-report") && repairedRecoveryHistory.some((run) => run.id === "broken-history" && run.status === "failed"));
	const unreadableTaskRoot = join(root, "unreadable-task-recovery");
	const unreadableTaskRun = join(unreadableTaskRoot, ".pi", "herdr-subagents", "runs", "run");
	const unreadableTaskDirectory = join(unreadableTaskRun, "tasks", "01-task");
	mkdirSync(unreadableTaskDirectory, { recursive: true });
	writeFileSync(join(unreadableTaskRun, "run.json"), JSON.stringify({ id: "unreadable-task", label: "unreadable-task", status: "running", tabId: "w1:t-unreadable", startedAt: new Date().toISOString() }));
	writeFileSync(join(unreadableTaskDirectory, "task.json"), "{truncated");
	const unreadableTaskHerdr = fakeHerdr();
	const unreadableTaskRecovery = await reconcileSubagentRuns(unreadableTaskRoot, unreadableTaskHerdr);
	const unreadableRunRecord = JSON.parse(readFileSync(join(unreadableTaskRun, "run.json"), "utf8"));
	check("unreadable task records cannot aggregate to completed", unreadableRunRecord.status === "failed" && unreadableTaskRecovery.interruptedTasks === 1 && unreadableTaskRecovery.cleanupErrors.some((message) => message.includes("Could not inspect Subagent task")) && unreadableTaskHerdr.calls.some(([name]) => name === "closeTab"));
	const invalidTaskRoot = join(root, "invalid-task-recovery");
	const invalidTaskRun = join(invalidTaskRoot, ".pi", "herdr-subagents", "runs", "run");
	const invalidTaskDirectory = join(invalidTaskRun, "tasks", "01-task");
	mkdirSync(invalidTaskDirectory, { recursive: true });
	writeFileSync(join(invalidTaskRun, "run.json"), JSON.stringify({ id: "invalid-task", label: "invalid-task", status: "running", tabId: "w1:t-invalid", startedAt: new Date().toISOString() }));
	writeFileSync(join(invalidTaskDirectory, "task.json"), JSON.stringify({ id: "invalid", runId: "invalid-task", status: "bogus", sessionFile: join(invalidTaskDirectory, "session.jsonl") }));
	const invalidTaskHerdr = fakeHerdr();
	await reconcileSubagentRuns(invalidTaskRoot, invalidTaskHerdr);
	check("semantic task corruption fails recovery and closes its tab", JSON.parse(readFileSync(join(invalidTaskRun, "run.json"), "utf8")).status === "failed" && invalidTaskHerdr.calls.some(([name]) => name === "closeTab"));
	const missingOrderFile = join(root, "missing-order-task.json");
	writeFileSync(missingOrderFile, JSON.stringify({ id: "missing-order", runId: "invalid-task", status: "completed" }));
	let missingOrderError = "";
	try { await readTaskRecord(missingOrderFile); } catch (error) { missingOrderError = error.message; }
	check("durable task records require a positive integer order", missingOrderError.includes("Invalid task order"));
	const shellRecoveryTask = JSON.parse(readFileSync(join(recoveryTask, "task.json"), "utf8"));
	Object.assign(shellRecoveryTask, { status: "running" });
	writeFileSync(join(recoveryTask, "task.json"), JSON.stringify(shellRecoveryTask));
	writeFileSync(join(recoveryRoot, ".pi", "herdr-subagents", "runs", "run", "run.json"), JSON.stringify({ id: "recover", label: "recover", status: "running", startedAt: new Date().toISOString() }));
	const shellReconciliation = await reconcileSubagentRuns(recoveryRoot, fakeHerdr("shell-only"), { sessionId: "new-owner" });
	check("pane with only a shell is not treated as live child", shellReconciliation.interruptedTasks === 1);
	const nodeProcessHerdr = join(root, "node-process-herdr");
	writeFileSync(nodeProcessHerdr, `#!/bin/sh\nprintf '%s\\n' '{"result":{"process_info":{"foreground_processes":[{"name":"node","argv":["/usr/bin/node","/opt/pi-coding-agent/dist/bundle/cli.js"]}]}}}'\n`);
	chmodSync(nodeProcessHerdr, 0o700);
	check("node-hosted Pi process is treated as live", await new CliHerdrAutomation(nodeProcessHerdr).isTaskRunning("w1:p2"));
	const listenerController = new AbortController();
	await new CliHerdrAutomation(nodeProcessHerdr).isTaskRunning("w1:p2", listenerController.signal);
	const focusCounter = join(root, "focus-counter");
	const focusPollHerdr = join(root, "focus-herdr");
	writeFileSync(focusPollHerdr, `#!/bin/sh\ncount=$(cat '${focusCounter}' 2>/dev/null || echo 0)\ncount=$((count + 1))\nprintf '%s' "$count" > '${focusCounter}'\nif [ "$count" -eq 1 ]; then printf '%s\\n' '{"result":{"tab":{"focused":true}}}'; else printf '%s\\n' '{"result":{"tab":{"focused":false}}}'; fi\n`);
	chmodSync(focusPollHerdr, 0o700);
	await new CliHerdrAutomation(focusPollHerdr).waitForTabUnfocused("w1:t1", listenerController.signal);
	check("completed Herdr commands and focus polling remove abort listeners", getEventListeners(listenerController.signal, "abort").length === 0);
	const transientHerdr = join(root, "transient-herdr");
	writeFileSync(transientHerdr, `#!/bin/sh\necho 'temporary transport failure' >&2\nexit 1\n`);
	chmodSync(transientHerdr, 0o700);
	let processQueryError = "";
	try { await new CliHerdrAutomation(transientHerdr).isTaskRunning("w1:p2"); } catch (error) { processQueryError = error.message; }
	check("transient process query failure is surfaced", processQueryError.includes("temporary transport failure"));
	let paneLookupError = "";
	try { await new CliHerdrAutomation(transientHerdr).paneExists("w1:p2"); } catch (error) { paneLookupError = error.message; }
	check("transient pane lookup failure is surfaced", paneLookupError.includes("temporary transport failure"));
	const missingPaneHerdr = join(root, "missing-pane-herdr");
	writeFileSync(missingPaneHerdr, `#!/bin/sh\necho 'pane_not_found: unknown pane' >&2\nexit 1\n`);
	chmodSync(missingPaneHerdr, 0o700);
	check("confirmed missing pane lookup returns false", !(await new CliHerdrAutomation(missingPaneHerdr).paneExists("w1:missing")));

	const queuedRecoveryRoot = join(root, "queued-recovery");
	const queuedRunDirectory = join(queuedRecoveryRoot, ".pi", "herdr-subagents", "runs", "run");
	const firstRecoveryTask = join(queuedRunDirectory, "tasks", "01-first");
	const secondRecoveryTask = join(queuedRunDirectory, "tasks", "02-second");
	mkdirSync(firstRecoveryTask, { recursive: true });
	mkdirSync(secondRecoveryTask, { recursive: true });
	writeFileSync(join(queuedRunDirectory, "run.json"), JSON.stringify({ id: "queued-recovery", label: "queued-recovery", status: "running", cwd: queuedRecoveryRoot, effectiveConcurrency: 2, startedAt: new Date().toISOString(), tabId: "w1:t2", paneIds: ["w1:p2"] }));
	writeFileSync(join(firstRecoveryTask, "task.json"), JSON.stringify({ id: "first", runId: "queued-recovery", order: 1, name: "first", status: "running", paneId: "w1:p2", sessionFile: join(firstRecoveryTask, "session.jsonl") }));
	writeFileSync(join(firstRecoveryTask, "report.json"), JSON.stringify({ status: "completed", summary: "first completed", documents: [] }));
	writeFileSync(join(secondRecoveryTask, "task.json"), JSON.stringify({ id: "second", runId: "queued-recovery", order: 2, name: "second", status: "queued", prompt: "second", agent: "explorer", tools: ["read"], skills: [], sessionFile: join(secondRecoveryTask, "session.jsonl") }));
	writeFileSync(join(secondRecoveryTask, "system-prompt.md"), "Report the result.");
	const thirdRecoveryTask = join(queuedRunDirectory, "tasks", "03-third");
	mkdirSync(thirdRecoveryTask, { recursive: true });
	writeFileSync(join(thirdRecoveryTask, "task.json"), JSON.stringify({ id: "third", runId: "queued-recovery", order: 3, name: "third", status: "queued", prompt: "third", agent: "reviewer", tools: ["read"], skills: [], sessionFile: join(thirdRecoveryTask, "session.jsonl") }));
	writeFileSync(join(thirdRecoveryTask, "system-prompt.md"), "Report the result.");
	const queuedRecoveryHerdr = fakeHerdr();
	await reconcileSubagentRuns(queuedRecoveryRoot, queuedRecoveryHerdr);
	check("reconciliation preserves unstarted task records as queued", JSON.parse(readFileSync(join(secondRecoveryTask, "task.json"), "utf8")).status === "queued" && JSON.parse(readFileSync(join(thirdRecoveryTask, "task.json"), "utf8")).status === "queued");
	await continueQueuedRun(queuedRunDirectory, queuedRecoveryHerdr);
	check("startup continuation restores bounded concurrency", queuedRecoveryHerdr.maxActive === 2 && JSON.parse(readFileSync(join(secondRecoveryTask, "task.json"), "utf8")).status === "completed" && JSON.parse(readFileSync(join(thirdRecoveryTask, "task.json"), "utf8")).status === "completed" && JSON.parse(readFileSync(join(queuedRunDirectory, "run.json"), "utf8")).status === "completed");
	const staleContinuationRoot = join(root, "stale-continuation");
	const staleContinuationRun = join(staleContinuationRoot, ".pi", "herdr-subagents", "runs", "run");
	const staleContinuationTask = join(staleContinuationRun, "tasks", "01-task");
	mkdirSync(staleContinuationTask, { recursive: true });
	writeFileSync(join(staleContinuationRun, "run.json"), JSON.stringify({ id: "stale-continuation", label: "stale-continuation", status: "running", cwd: staleContinuationRoot, effectiveConcurrency: 1, tabId: "w1:t-old", paneIds: ["w1:p-old"], startedAt: new Date().toISOString() }));
	writeFileSync(join(staleContinuationTask, "task.json"), JSON.stringify({ id: "stale-task", runId: "stale-continuation", order: 1, name: "stale-task", status: "queued", prompt: "continue", agent: "explorer", skills: [], sessionFile: join(staleContinuationTask, "session.jsonl") }));
	writeFileSync(join(staleContinuationTask, "system-prompt.md"), "Report the result.");
	const staleContinuationHerdr = fakeHerdr();
	staleContinuationHerdr.paneExists = async () => false;
	staleContinuationHerdr.createTab = async (request) => { staleContinuationHerdr.calls.push(["createTab", request]); return { tabId: "w1:t-new", paneId: "w1:p-new" }; };
	await continueQueuedRun(staleContinuationRun, staleContinuationHerdr);
	const staleContinuationRecord = JSON.parse(readFileSync(join(staleContinuationRun, "run.json"), "utf8"));
	check("queued recovery closes a replaced stale tab", staleContinuationRecord.status === "completed" && staleContinuationRecord.tabId === "w1:t-new" && !staleContinuationRecord.staleTabIds && staleContinuationHerdr.calls.some(([name, request]) => name === "closeTab" && request.tabId === "w1:t-old"));
	const failedCleanupRoot = join(root, "stale-continuation-cleanup-failure");
	const failedCleanupRun = join(failedCleanupRoot, ".pi", "herdr-subagents", "runs", "run");
	const failedCleanupTask = join(failedCleanupRun, "tasks", "01-task");
	mkdirSync(failedCleanupTask, { recursive: true });
	writeFileSync(join(failedCleanupRun, "run.json"), JSON.stringify({ id: "stale-cleanup-failure", label: "stale-cleanup-failure", status: "running", cwd: failedCleanupRoot, effectiveConcurrency: 1, tabId: "w1:t-old", paneIds: ["w1:p-old"], startedAt: new Date().toISOString() }));
	writeFileSync(join(failedCleanupTask, "task.json"), JSON.stringify({ id: "stale-cleanup-task", runId: "stale-cleanup-failure", order: 1, name: "stale-cleanup-task", status: "queued", prompt: "continue", agent: "explorer", skills: [], sessionFile: join(failedCleanupTask, "session.jsonl") }));
	writeFileSync(join(failedCleanupTask, "system-prompt.md"), "Report the result.");
	const failedCleanupHerdr = fakeHerdr("close-failed");
	failedCleanupHerdr.paneExists = async () => false;
	failedCleanupHerdr.createTab = async (request) => { failedCleanupHerdr.calls.push(["createTab", request]); return { tabId: "w1:t-new", paneId: "w1:p-new" }; };
	const continuationCleanupErrors = [];
	await continueQueuedRun(failedCleanupRun, failedCleanupHerdr, { cleanup: false, onCleanupError: (message) => continuationCleanupErrors.push(message) });
	const failedCleanupRecord = JSON.parse(readFileSync(join(failedCleanupRun, "run.json"), "utf8"));
	check("queued continuation persists and surfaces stale-tab cleanup failure", failedCleanupRecord.cleanupError?.includes("tab still busy") && failedCleanupRecord.staleTabIds?.includes("w1:t-old") && continuationCleanupErrors.some((message) => message.includes("tab still busy")));

	const blockedSlotsDirectory = join(root, "blocked-slots", ".pi", "herdr-subagents", "runs", "run");
	mkdirSync(join(blockedSlotsDirectory, "tasks", "01-blocked"), { recursive: true });
	mkdirSync(join(blockedSlotsDirectory, "tasks", "02-queued"), { recursive: true });
	mkdirSync(join(blockedSlotsDirectory, "tasks", "03-queued"), { recursive: true });
	writeFileSync(join(blockedSlotsDirectory, "run.json"), JSON.stringify({ id: "blocked-slots", label: "blocked-slots", status: "blocked", cwd: join(root, "blocked-slots"), effectiveConcurrency: 2, tabId: "w1:t2", paneIds: ["w1:p2"] }));
	writeFileSync(join(blockedSlotsDirectory, "tasks", "01-blocked", "task.json"), JSON.stringify({ id: "blocked", runId: "blocked-slots", order: 1, name: "blocked", status: "blocked", paneId: "w1:p2", sessionFile: join(blockedSlotsDirectory, "tasks", "01-blocked", "session.jsonl") }));
	for (const order of [2, 3]) {
		const directory = join(blockedSlotsDirectory, "tasks", `0${order}-queued`);
		writeFileSync(join(directory, "task.json"), JSON.stringify({ id: `queued-${order}`, runId: "blocked-slots", order, name: `queued-${order}`, status: "queued", prompt: `queued-${order}`, agent: "explorer", tools: ["read"], skills: [], sessionFile: join(directory, "session.jsonl") }));
		writeFileSync(join(directory, "system-prompt.md"), "Report the result.");
	}
	const blockedSlotsHerdr = fakeHerdr();
	await continueQueuedRun(blockedSlotsDirectory, blockedSlotsHerdr, { cleanup: false });
	check("blocked Agent is subtracted from continuation concurrency", blockedSlotsHerdr.maxActive === 1 && blockedSlotsHerdr.calls.filter(([name]) => name === "startAgent").length === 2);
} finally {
	restoreEnv();
	rmSync(root, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

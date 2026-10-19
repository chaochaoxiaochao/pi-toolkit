import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executeHerdrSubagents } from "../src/tool.ts";
import { CliHerdrAutomation } from "../src/herdr.ts";
import { waitFor } from "./wait-for.mjs";
import { smokePersona } from "./real-herdr-config.mjs";

if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) {
	throw new Error("The real Herdr smoke test must run from a Pi session inside Herdr.");
}

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimePersona = smokePersona(process.env.INIT_CWD || process.cwd(), join(packageDirectory, "agents"), process.env.HERDR_SUBAGENTS_E2E_MODEL);
const root = mkdtempSync(join(tmpdir(), "pi-herdr-subagents-real-"));
const herdr = new CliHerdrAutomation();
const tabIds = new Set();
const paneIds = new Set();
const trace = [];
const startedAt = performance.now();
let failed = false;
let controlledFocus;
function record(event) {
	trace.push({ elapsedMs: Math.round(performance.now() - startedAt), ...event });
	writeFileSync(join(root, "trace.json"), JSON.stringify(trace, null, 2));
}
for (const method of ["createTab", "splitPane", "startAgent", "isTabFocused", "waitForTabUnfocused", "closeTab", "paneExists"]) {
	const original = herdr[method].bind(herdr);
	herdr[method] = async (...args) => {
		if (method === "isTabFocused" && controlledFocus && !controlledFocus.triggered && tabIds.has(args[0])) {
			const focused = spawnSync(process.env.PI_HERDR_SUBAGENTS_HERDR_BINARY?.trim() || "herdr", ["tab", "focus", args[0]], { encoding: "utf8", timeout: 10_000 });
			assert.equal(focused.status, 0, focused.stderr);
			controlledFocus.triggered = true;
			record({ event: "controlled-focus", tabId: args[0], previousWorkspaceId: controlledFocus.previousWorkspaceId, previousTabId: controlledFocus.previousTabId });
		}
		record({ method, phase: "start", args: args.map((arg) => typeof arg === "object" ? { ...arg, signal: undefined } : arg) });
		try {
			const result = await original(...args);
			if (result?.tabId) tabIds.add(result.tabId);
			if (result?.paneId) paneIds.add(result.paneId);
			record({ method, phase: "end", result });
			return result;
		} catch (error) {
			record({ method, phase: "error", error: String(error), stderr: error.stderr });
			throw error;
		}
	};
}
const configurationPaths = {
	globalConfig: join(root, "global-config.json"),
	projectConfig: join(root, "project-config.json"),
	globalAgents: join(root, "global-agents"),
	projectAgents: join(root, "project-agents"),
};
const timeout = AbortSignal.timeout(120_000);

function hasAssistantMessage(path) {
	return readFileSync(path, "utf8").split("\n").filter(Boolean).some((line) => {
		try { return JSON.parse(line)?.message?.role === "assistant"; }
		catch { return false; }
	});
}

function restoreTestFocus() {
	if (!controlledFocus?.triggered || controlledFocus.restored) return;
	const restored = spawnSync(process.env.PI_HERDR_SUBAGENTS_HERDR_BINARY?.trim() || "herdr", ["tab", "focus", controlledFocus.previousTabId], { encoding: "utf8", timeout: 10_000 });
	assert.equal(restored.status, 0, restored.stderr);
	const workspace = spawnSync(process.env.PI_HERDR_SUBAGENTS_HERDR_BINARY?.trim() || "herdr", ["workspace", "focus", controlledFocus.previousWorkspaceId], { encoding: "utf8", timeout: 10_000 });
	assert.equal(workspace.status, 0, workspace.stderr);
	controlledFocus.restored = true;
	assertRestoredFocus();
	record({ event: "restored-focus", workspaceId: controlledFocus.previousWorkspaceId, tabId: controlledFocus.previousTabId });
}

function assertRestoredFocus() {
	const result = spawnSync(process.env.PI_HERDR_SUBAGENTS_HERDR_BINARY?.trim() || "herdr", ["workspace", "list"], { encoding: "utf8", timeout: 10_000 });
	assert.equal(result.status, 0, result.stderr);
	const focused = JSON.parse(result.stdout).result.workspaces.find((workspace) => workspace.focused);
	assert.equal(focused?.workspace_id, controlledFocus.previousWorkspaceId, "The original workspace focus was not restored");
	assert.equal(focused?.active_tab_id, controlledFocus.previousTabId, "The original tab focus was not restored");
}

async function waitForCleanup(result) {
	const signal = AbortSignal.timeout(5_000);
	await waitFor(async () => {
		const run = JSON.parse(readFileSync(join(result.recordDirectory, "run.json"), "utf8"));
		if (run.cleanupError) throw new Error(`Cleanup failed: ${run.cleanupError}`);
		const survivingPaneIds = [];
		for (const task of result.tasks) if (await herdr.paneExists(task.paneId, signal)) survivingPaneIds.push(task.paneId);
		record({ event: "cleanup-observation", run, survivingPaneIds });
		return !run.cleanupPendingTabIds?.length && survivingPaneIds.length === 0 && !existsSync(join(result.recordDirectory, ".state.lock"));
	}, `cleanup of ${result.tabId}`, 5_000);
}

async function runCase(label, names, concurrency, extraExtensions = []) {
	const extensions = [...runtimePersona.extensions, ...extraExtensions];
	writeFileSync(configurationPaths.globalConfig, JSON.stringify({ defaultExtensions: extensions, personas: { analyst: { model: runtimePersona.model, thinking: runtimePersona.thinking } } }));
	if (concurrency > 1 && process.env.HERDR_SUBAGENTS_E2E_FOCUS_CLEANUP === "1") {
		const workspaces = spawnSync(process.env.PI_HERDR_SUBAGENTS_HERDR_BINARY?.trim() || "herdr", ["workspace", "list"], { encoding: "utf8", timeout: 10_000 });
		assert.equal(workspaces.status, 0, workspaces.stderr);
		const previous = JSON.parse(workspaces.stdout).result.workspaces.find((workspace) => workspace.focused);
		assert.ok(previous?.active_tab_id, "The focused cleanup probe needs an existing focused tab to restore");
		controlledFocus = { previousWorkspaceId: previous.workspace_id, previousTabId: previous.active_tab_id, triggered: false, restored: false };
	}
	const response = await executeHerdrSubagents({
		label,
		concurrency,
		tasks: names.map((name) => ({
			name,
			agent: "analyst",
			prompt: `Do not inspect files. Call subagent_report with status completed, summary '${name} completed', and result 'hello'.`,
		})),
	}, timeout, (update) => {
		if (update.details?.tabId) tabIds.add(update.details.tabId);
		if (update.details?.cleanupError) record({ event: "cleanup-warning", details: update.details, content: update.content });
	}, { cwd: root }, {
		agentsDirectory: join(packageDirectory, "agents"),
		configurationPaths,
		herdr,
	});

	const result = response.details;
	if (result?.tabId) tabIds.add(result.tabId);
	record({ event: "case-result", label, result, run: result?.recordDirectory ? JSON.parse(readFileSync(join(result.recordDirectory, "run.json"), "utf8")) : undefined });
	assert.equal(response.isError, undefined, response.content?.[0]?.text);
	assert.equal(result.status, "completed");
	assert.equal(result.effectiveConcurrency, concurrency);
	assert.equal(result.tasks.length, names.length);
	assert.equal(new Set(result.tasks.map((task) => task.paneId)).size, names.length);

	if (controlledFocus) {
		assert.equal(controlledFocus.triggered, true, "The focus probe did not reach cleanup");
		const run = JSON.parse(readFileSync(join(result.recordDirectory, "run.json"), "utf8"));
		assert.ok(run.cleanupPendingTabIds?.includes(result.tabId), "Focused cleanup was not deferred");
		restoreTestFocus();
	}
	await waitForCleanup(result);
	if (controlledFocus) {
		assertRestoredFocus();
		console.log("PASS focused cleanup: deferred while focused, original workspace/tab focus restored, automatic cleanup observed");
	}
	for (const taskResult of result.tasks) {
		const task = JSON.parse(readFileSync(join(taskResult.recordDirectory, "task.json"), "utf8"));
		const report = JSON.parse(readFileSync(join(taskResult.recordDirectory, "report.json"), "utf8"));
		assert.equal(task.status, "completed");
		assert.deepEqual(task.extensions, extensions);
		if (runtimePersona.model) assert.equal(task.model, runtimePersona.model);
		if (extraExtensions.length) {
			const commands = JSON.parse(readFileSync(join(taskResult.recordDirectory, "extension-loaded.json"), "utf8"));
			assert.ok(commands.includes("skill:smoke-package-skill"), "Explicit package skill did not load in the real child");
		}
		assert.equal(report.status, "completed");
		assert.equal(report.attemptId, task.currentAttemptId);
		assert.equal(hasAssistantMessage(task.sessionFile), true, `${taskResult.name} produced no assistant event`);
		assert.equal(await herdr.paneExists(task.paneId), false, `${taskResult.name} pane survived tab cleanup`);
	}
	console.log(`PASS ${label}: ${names.length} real child Agent${names.length === 1 ? "" : "s"} completed and cleaned up`);
}

try {
	await runCase("real-single", ["hello-single"], 1);
	const packageSource = join(root, "local-package");
	mkdirSync(join(packageSource, "skills", "smoke-package-skill"), { recursive: true });
	writeFileSync(join(packageSource, "package.json"), JSON.stringify({ name: "herdr-smoke-package", pi: { extensions: ["extension.ts"], skills: ["skills"] } }));
	writeFileSync(join(packageSource, "skills", "smoke-package-skill", "SKILL.md"), "---\nname: smoke-package-skill\ndescription: A real Herdr package-loading probe\n---\n# Probe\n");
	writeFileSync(join(packageSource, "extension.ts"), `import { writeFileSync } from "node:fs";
		import { join } from "node:path";
		export default function (pi) {
			pi.on("session_start", () => writeFileSync(join(process.env.PI_HERDR_SUBAGENTS_TASK_DIR, "extension-loaded.json"), JSON.stringify(pi.getCommands().map((command) => command.name))));
		}`);
	await runCase("real-concurrent", ["hello-one", "hello-two"], 2, [packageSource]);
} catch (error) {
	failed = true;
	const snapshots = [];
	for (const [kind, ids] of [["tab", tabIds], ["pane", paneIds]]) for (const id of ids) {
		const result = spawnSync(process.env.PI_HERDR_SUBAGENTS_HERDR_BINARY?.trim() || "herdr", [kind, "get", id], { encoding: "utf8", timeout: 10_000 });
		snapshots.push({ kind, id, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error ? String(result.error) : undefined });
	}
	writeFileSync(join(root, "failure.json"), JSON.stringify({ error: String(error), snapshots }, null, 2));
	console.error(`FAIL real Herdr smoke; preserved diagnostics: ${root}`);
	throw error;
} finally {
	const cleanupErrors = [];
	try { restoreTestFocus(); } catch (error) { cleanupErrors.push(String(error)); }
	for (const tabId of tabIds) await herdr.closeTab(tabId, AbortSignal.timeout(10_000)).catch((error) => {
		if (!/tab[_ -]?not[_ -]?found|unknown tab/i.test(`${error}\n${error.stderr ?? ""}`)) cleanupErrors.push(String(error));
	});
	if (cleanupErrors.length) {
		failed = true;
		writeFileSync(join(root, "teardown-errors.json"), JSON.stringify(cleanupErrors, null, 2));
		console.error(`FAIL smoke teardown; preserved diagnostics: ${root}`);
		process.exitCode = 1;
	}
	if (!failed) rmSync(root, { recursive: true, force: true });
}

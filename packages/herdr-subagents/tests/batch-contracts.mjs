import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";
import { runHerdrSubagentsBatch } from "../src/batch-runner.ts";
import { continueQueuedRun } from "../src/continue-run.ts";
import { executeHerdrSubagents, executeHerdrSubagentsControl } from "../src/tool.ts";
import { HERDR_ACTIONS, validateControlParams } from "../src/validation.ts";
import { listSubagentHistory } from "../src/history.ts";
import { aggregateTaskStatus } from "../src/run-status.ts";
import { isAbortError } from "../src/errors.ts";
import registerReport from "../extensions/subagent-report.ts";
import { batchFixture, batchTask, durableRun, readJson, readTask, waitGate, writeJson } from "./fixtures/herdr.mjs";

process.env.HERDR_ENV = "1";
process.env.HERDR_WORKSPACE_ID = "test-workspace";
const agentsDirectory = fileURLToPath(new URL("../agents/", import.meta.url));
const options = (f, extra = {}) => ({ label: "contract", concurrency: 2, maxConcurrency: 3, cwd: f.root, herdr: f.herdr, ...extra });

for (const action of Object.keys(HERDR_ACTIONS)) {
	const base = ["list", "history"].includes(action) ? { action } : { action, runId: "one" };
	assert.equal(validateControlParams(base), undefined);
	assert.match(validateControlParams({ ...base, prompt: "unexpected" }), /not valid/);
	if (base.runId) assert.match(validateControlParams({ action, runId: " " }), /runId is required/);
}
assert.match(validateControlParams({ action: "history", runId: "unexpected" }), /not valid/);
for (const action of ["respond", "resume", "unknown"]) assert.match(validateControlParams({ action }), /valid control action/);
assert.throws(() => aggregateTaskStatus(["unknown"]), /unknown/i);
assert.equal(aggregateTaskStatus(["failed", "cancelled"]), "failed");
assert.equal(aggregateTaskStatus(["completed", "failed", "cancelled"]), "partial");
assert.equal(isAbortError(Object.assign(new Error("stop"), { name: "AbortError" })), true);
assert.equal(isAbortError(new Error("provider unavailable")), false);
{
	const f = batchFixture();
	try {
		process.env.HERDR_ENV = "0";
		await assert.rejects(runHerdrSubagentsBatch([batchTask("one")], options(f)), /inside Herdr/);
		assert.equal(f.calls.length, 0);
		assert.equal(existsSync(join(f.root, ".pi")), false);
		process.env.HERDR_ENV = "1";
		let cancelled;
		const response = await executeHerdrSubagentsControl({ action: "cancel", runId: "selected-run" }, undefined, undefined, { cwd: f.root }, {
			agentsDirectory, configurationPaths: { globalConfig: join(f.root, "none.json") },
			cancelRun: async (runId) => { cancelled = runId; return { cancelled: true }; },
		});
		assert.equal(response.isError, undefined);
		assert.equal(cancelled, "selected-run");
	} finally { process.env.HERDR_ENV = "1"; f.close(); }
}
console.log("PASS current control allow/deny matrix, Herdr rejection without side effects and exact cancel dispatch");

{
	const waiting = Promise.withResolvers();
	const failed = Promise.withResolvers();
	const controller = new AbortController();
	const f = batchFixture(async ({ directory, request, publish }) => {
		if (readTask(directory).name === "failure") publish(directory, { status: "failed", summary: "failed explicitly" });
		else { waiting.resolve(); await waitGate(Promise.withResolvers(), request.signal); }
	});
	let outcome;
	try {
		outcome = executeHerdrSubagents({
			concurrency: 2, tasks: ["failure", "cancelled"].map((name) => ({ name, prompt: name, agent: "explorer" })),
		}, controller.signal, (update) => {
			if (update.details.tasks?.some((task) => task.status === "failed")) failed.resolve();
		}, { cwd: f.root }, {
			agentsDirectory, herdr: f.herdr,
			configurationPaths: { globalConfig: join(f.root, "none.json"), globalAgents: join(f.root, "none-agents") },
		});
		await Promise.all([waiting.promise, failed.promise]);
		controller.abort(new Error("cancel remaining task"));
		const response = await outcome;
		assert.equal(response.details.status, "failed");
		assert.deepEqual(response.details.tasks.map((task) => task.status), ["failed", "cancelled"]);
		assert.equal(readJson(join(response.details.recordDirectory, "run.json")).status, "failed");
		for (const task of response.details.tasks) assert.equal(readTask(task.recordDirectory).status, task.status);
	} finally { controller.abort(); await outcome; f.close(); }
}
console.log("PASS public hard failure remains failed when an already-running sibling is cancelled");

{
	const launched = [];
	const f = batchFixture(({ directory, publish }) => {
		const name = readTask(directory).name;
		launched.push(name);
		publish(directory, name === "first" ? { status: "failed", summary: "hard failure", error: "confirmed failure" } : { status: "completed", summary: "unexpected start" });
	});
	try {
		const result = await runHerdrSubagentsBatch(["first", "second", "third", "fourth"].map((name) => batchTask(name)), options(f, { concurrency: 1 }));
		assert.equal(result.status, "failed");
		assert.deepEqual(launched, ["first"]);
		assert.deepEqual(result.tasks.map((task) => task.status), ["failed", "cancelled", "cancelled", "cancelled"]);
		assert.match(result.summary, /first failed/);
		assert.ok(result.tasks.slice(1).every((task) => task.error === "Not started because first failed."));
		for (const task of result.tasks) assert.equal(readTask(task.recordDirectory).status, task.status);
	} finally { f.close(); }
}
{
	const launched = [];
	const siblingStarted = Promise.withResolvers();
	const failureSeen = Promise.withResolvers();
	const releaseSibling = Promise.withResolvers();
	const f = batchFixture(async ({ directory, publish }) => {
		const name = readTask(directory).name;
		launched.push(name);
		if (name === "first") {
			await siblingStarted.promise;
			publish(directory, { status: "failed", summary: "hard failure", error: "confirmed failure" });
			return;
		}
		if (name === "second") {
			siblingStarted.resolve();
			await releaseSibling.promise;
			publish(directory, { status: "completed", summary: "already-running sibling completed" });
			return;
		}
		publish(directory, { status: "completed", summary: "unexpected start" });
	});
	try {
		const outcome = runHerdrSubagentsBatch(["first", "second", "third", "fourth"].map((name) => batchTask(name)), options(f, {
			concurrency: 2,
			onUpdate: (update) => {
				if (update.tasks.some((task) => task.name === "first" && task.status === "failed")) failureSeen.resolve();
			},
		}));
		await siblingStarted.promise;
		await failureSeen.promise;
		releaseSibling.resolve();
		const result = await outcome;
		assert.equal(result.status, "partial");
		assert.deepEqual(launched.sort(), ["first", "second"]);
		assert.deepEqual(result.tasks.map((task) => task.status), ["failed", "completed", "cancelled", "cancelled"]);
		assert.match(result.summary, /first failed/);
	} finally { releaseSibling.resolve(); f.close(); }
}
console.log("PASS hard failure stops queued work while already-running siblings finish");

for (const method of ["createTab", "splitPane", "startAgent"]) {
	const f = batchFixture();
	const failures = [];
	const attemptsAtStart = new Map();
	f.herdr[method] = async (...args) => {
		failures.push(args);
		if (method === "startAgent") {
			const argv = args[0].args;
			const directory = dirname(argv[argv.indexOf("--session") + 1]);
			const attempt = readTask(directory).currentAttemptId;
			assert.match(attempt, /^[0-9a-f-]{36}$/i);
			attemptsAtStart.set(directory, attempt);
		}
		throw new Error(`${method}: uncertain result`);
	};
	try {
		const result = await runHerdrSubagentsBatch(["one", "two", "three"].map((name) => batchTask(name)), options(f));
		assert.ok(["partial", "failed"].includes(result.status));
		assert.equal(result.tasks.length, 3);
		assert.ok(result.activity.every((task) => ["completed", "failed", "cancelled"].includes(task.status)));
		assert.equal(failures.length, method === "startAgent" ? 2 : 1, "an uncertain allocation is not retried, nor queued work started after failure");
		if (method === "startAgent") assert.equal(new Set(failures.map(([request]) => request.name)).size, 2);
		const delivered = f.calls.filter(([name]) => name === "promptAgent");
		assert.equal(delivered.length, method === "splitPane" ? 1 : 0);
		assert.equal(readJson(join(result.recordDirectory, "run.json")).status, result.status);
		for (const task of result.tasks) {
			const record = readTask(task.recordDirectory);
			assert.equal(record.status, task.status);
			if (method === "startAgent" && task.status === "failed") {
				assert.ok(attemptsAtStart.has(task.recordDirectory));
				assert.equal(record.currentAttemptId, attemptsAtStart.get(task.recordDirectory), "startup failure must preserve the persisted attempt identity");
			}
		}
		assert.equal(existsSync(join(result.recordDirectory, ".queue.lock")), false);
		assert.equal(existsSync(join(result.recordDirectory, ".state.lock")), false);
	} finally { f.close(); }
}
console.log("PASS create/split/start uncertain failures never duplicate execution, stop queued work and settle durably");

{
	const f = batchFixture();
	try {
		const queued = durableRun(f.root, "resume-queue", "running", { cwd: f.root, paneIds: [], tabId: undefined, effectiveConcurrency: 1 });
		writeJson(queued.taskFile, { ...queued.task, status: "queued", prompt: "Run resumed queue fixture." });
		const secondDirectory = join(queued.directory, "tasks", "02-second");
		const secondFile = join(secondDirectory, "task.json");
		writeJson(secondFile, { ...queued.task, id: "resume-queue-second", order: 2, name: "second", status: "queued", prompt: "Must not start.", sessionFile: join(secondDirectory, "session.jsonl") });
		writeJson(queued.runFile, { ...queued.run, taskIds: [queued.task.id, "resume-queue-second"] });
		let attempt;
		let starts = 0;
		f.herdr.startAgent = async () => {
			starts += 1;
			attempt = readTask(queued.taskDirectory).currentAttemptId;
			assert.match(attempt, /^[0-9a-f-]{36}$/i);
			throw new Error("resumed queue launch failed");
		};
		await continueQueuedRun(queued.directory, f.herdr, { cleanup: false });
		const settled = readTask(queued.taskDirectory);
		assert.equal(settled.status, "failed");
		assert.equal(settled.error, "resumed queue launch failed");
		assert.equal(settled.currentAttemptId, attempt);
		assert.equal(readTask(secondDirectory).status, "cancelled");
		assert.equal(starts, 1);
	} finally { f.close(); }
}
console.log("PASS failed continued queue launch retains the attempt identity and stops later queued work");


for (const [label, report] of [
	["json", "{broken"], ["status", { status: "unknown", summary: "bad", documents: [] }],
	["documents", { status: "completed", summary: "bad", documents: "bad" }],
	["attempt", { status: "completed", summary: "bad", documents: [], attemptId: "different-attempt" }],
]) {
	const f = batchFixture(({ directory }) => {
		const task = readTask(directory);
		const value = typeof report === "string" ? report : JSON.stringify({ attemptId: task.currentAttemptId, ...report });
		writeFileSync(join(directory, "reports", `${task.currentAttemptId}.json`), value);
		return { status: "idle" };
	});
	try {
		const result = await runHerdrSubagentsBatch([batchTask(label)], options(f, { concurrency: 1 }));
		assert.equal(result.status, "failed");
		const directory = result.tasks[0].recordDirectory;
		assert.match(result.tasks[0].error, /invalid subagent_report/);
		assert.ok(readdirSync(directory).some((name) => name.startsWith("report.json.invalid-")));
		assert.equal(readJson(join(directory, "report.json")).status, "failed");
		assert.equal(readTask(directory).status, "failed");
		assert.equal((await listSubagentHistory(f.root))[0].tasks[0].status, "failed");
	} finally { f.close(); }
}
{
	const f = batchFixture(({ directory, changed }) => {
		writeJson(join(directory, "report.json"), { status: "completed", summary: "old canonical report", documents: [] });
		// A canonical report is not evidence for the new attempt; only actual exit settles it.
		f.panes.get(readTask(directory).paneId).alive = false;
		changed.resolve();
		return { status: "idle" };
	});
	try {
		const result = await runHerdrSubagentsBatch([batchTask("stale")], options(f, { concurrency: 1 }));
		assert.equal(result.status, "failed");
		assert.match(result.tasks[0].error, /exited without submitting/);
	} finally { f.close(); }
}
console.log("PASS malformed, semantic-invalid, wrong-attempt and stale canonical reports cannot falsely complete a task");

{
	const f = batchFixture();
	const handlers = new Map();
	let tool;
	const old = process.env.PI_HERDR_SUBAGENTS_TASK_DIR;
	process.env.PI_HERDR_SUBAGENTS_TASK_DIR = f.root;
	try {
		registerReport({ on: (name, handler) => handlers.set(name, handler), registerTool: (definition) => { tool = definition; }, registerCommand() {}, registerShortcut() {}, events: { on() {} } });
		const saved = [];
		for (const [id, text] of [["11111111-1111-4111-8111-111111111111", "first result"], ["22222222-2222-4222-8222-222222222222", "second result"]]) {
			writeJson(join(f.root, "task.json"), { currentAttemptId: id });
			await handlers.get("before_agent_start")?.();
			await tool.execute(id, { status: "completed", summary: text, result: text, documents: [] });
			const path = readJson(join(f.root, "reports", `${id}.json`)).documents[0].path;
			saved.push(path);
			assert.equal(readFileSync(path, "utf8"), text);
		}
		assert.notEqual(saved[0], saved[1]);
		assert.equal(readFileSync(saved[0], "utf8"), "first result");
		assert.equal(existsSync(join(f.root, "report.json")), false, "children only publish attempt-scoped reports");
	} finally {
		if (old === undefined) delete process.env.PI_HERDR_SUBAGENTS_TASK_DIR; else process.env.PI_HERDR_SUBAGENTS_TASK_DIR = old;
		f.close();
	}
}
console.log("PASS distinct attempts retain independent full results");

{
	const f = batchFixture();
	const warnings = [];
	f.herdr.closeTab = async () => { throw new Error("tab busy"); };
	try {
		const result = await runHerdrSubagentsBatch([batchTask("done")], options(f, { concurrency: 1, onCleanupError: (text) => warnings.push(text) }));
		assert.equal(result.status, "completed");
		const run = readJson(join(result.recordDirectory, "run.json"));
		assert.equal(run.status, "completed");
		assert.match(run.cleanupError, /tab busy/);
		assert.deepEqual(run.cleanupPendingTabIds, ["tab-1"]);
		assert.equal(warnings.length, 1);
	} finally { f.close(); }
}
{
	const updates = [];
	const f = batchFixture(() => ({ status: "idle" }));
	const wait = f.herdr.waitForAgentChange;
	let advanced = false;
	f.herdr.waitForAgentChange = async (target, signal) => {
		if (!advanced) {
			advanced = true;
			mock.timers.tick(1000);
			assert.ok(updates.some((update) => update.summary.includes("appears stalled") && update.activity[0].status === "running"));
			f.publish(f.agents.get(target).directory);
		}
		return wait(target, signal);
	};
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const result = await runHerdrSubagentsBatch([batchTask("slow")], options(f, { concurrency: 1, stalledWarningSeconds: 1, onUpdate: (update) => updates.push(update) }));
		assert.equal(result.status, "completed");
		const count = updates.length;
		mock.timers.tick(10_000);
		assert.equal(updates.length, count, "settlement clears the warning timer");
	} finally { mock.timers.reset(); f.close(); }
}
console.log("PASS cleanup errors preserve business completion; fake-clock stalled warning does not end live work");

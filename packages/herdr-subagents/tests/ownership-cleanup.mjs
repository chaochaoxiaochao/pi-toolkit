import assert from "node:assert/strict";
import { join } from "node:path";
import { registerHerdrSubagents } from "../extensions/herdr-subagents.ts";
import { cancelActiveSubagentRuns } from "../src/reconcile.ts";
import { cleanupRunTab } from "../src/tab-cleanup.ts";
import { waitFor } from "./wait-for.mjs";
import { batchFixture, durableRun, readJson, readTask, waitGate, writeJson } from "./fixtures/herdr.mjs";

process.env.HERDR_ENV = "1";
process.env.HERDR_WORKSPACE_ID = "test-workspace";
delete process.env.PI_HERDR_SUBAGENTS_CHILD;
{
	const f = batchFixture();
	try {
		const a = durableRun(f.root, "owner-a", "running", { ownerSessionId: "A" });
		const b = durableRun(f.root, "owner-b", "running", { ownerSessionId: "B" });
		const bRunBefore = JSON.stringify(readJson(b.runFile));
		const bTaskBefore = JSON.stringify(readJson(b.taskFile));
		const cancelled = await cancelActiveSubagentRuns(f.root, f.herdr, { runId: "owner-a", owner: { sessionId: "A" }, reason: "selected cancellation" });
		assert.equal(cancelled.cancelledRuns, 1);
		assert.equal(readJson(a.runFile).status, "cancelled");
		assert.equal(readJson(a.taskFile).status, "cancelled");
		assert.equal(JSON.stringify(readJson(b.runFile)), bRunBefore);
		assert.equal(JSON.stringify(readJson(b.taskFile)), bTaskBefore);
		assert.deepEqual(f.calls.filter(([method]) => method === "closeTab").map(([, tab]) => tab), ["owner-a-tab"]);
		assert.equal(f.calls.some(([method]) => method === "isTabFocused"), false, "parent cancellation forces cleanup without focus waits");
		assert.equal((await cancelActiveSubagentRuns(f.root, f.herdr, { owner: { sessionId: "A" } })).cancelledRuns, 0);
		assert.equal(readJson(b.taskFile).status, "running");
	} finally { f.close(); }
}
console.log("PASS durable run cancellation respects selected run and parent owner, and persists task/run cancellation");

{
	const started = { a: Promise.withResolvers(), b: Promise.withResolvers() };
	const never = Promise.withResolvers();
	const f = batchFixture(async ({ directory, request }) => {
		started[readTask(directory).name].resolve(request.signal);
		await waitGate(never, request.signal);
	});
	let tabSequence = 0;
	const create = f.herdr.createTab;
	f.herdr.createTab = async (...args) => ({ ...await create(...args), tabId: `parent-tab-${++tabSequence}` });
	const events = new Map(), tools = new Map();
	const ctx = {
		cwd: f.root, mode: "rpc", sessionManager: { getSessionId: () => "parent-session" },
		ui: { setWidget() {}, notify() {} },
	};
	registerHerdrSubagents({ on: (name, handler) => events.set(name, handler), registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {} }, {
		herdr: f.herdr, isEditor: () => false, configurationCwd: f.root,
		configurationPaths: { globalConfig: join(f.root, "absent-global.json"), projectConfig: join(f.root, "absent-project.json"), globalAgents: join(f.root, "absent-global-agents"), projectAgents: join(f.root, "absent-project-agents") },
	});
	let a, b;
	try {
		await events.get("session_start")({}, ctx);
		let runA, runB;
		a = tools.get("herdr_subagents").execute("a", { tasks: [{ name: "a", prompt: "a", agent: "explorer" }] }, undefined, (update) => { runA = update.details.runId; }, ctx);
		const signalA = await started.a.promise;
		b = tools.get("herdr_subagents").execute("b", { tasks: [{ name: "b", prompt: "b", agent: "explorer" }] }, undefined, (update) => { runB = update.details.runId; }, ctx);
		const signalB = await started.b.promise;
		assert.notEqual(runA, runB);
		const cancel = await tools.get("herdr_subagents_control").execute("cancel", { action: "cancel", runId: runA }, undefined, undefined, ctx);
		assert.equal(cancel.details.cancelled, true);
		assert.equal(signalA.aborted, true);
		assert.equal(signalB.aborted, false, "cancel A must not abort in-flight B");
		assert.equal((await a).details.status, "cancelled");
		const foreign = durableRun(f.root, "foreign-owner", "running", { ownerSessionId: "another-parent" });
		await events.get("session_shutdown")({}, ctx);
		assert.equal(signalB.aborted, true);
		const bResult = await b;
		assert.equal(bResult.details.status, "cancelled");
		assert.equal(readJson(join(bResult.details.recordDirectory, "run.json")).status, "cancelled");
		assert.equal(readJson(foreign.runFile).status, "running");
		assert.ok(!f.calls.some(([method, tab]) => method === "closeTab" && tab === "foreign-owner-tab"));
		assert.equal(f.calls.filter(([method]) => method === "closeTab").length, 2);
	} finally {
		await events.get("session_shutdown")({}, ctx);
		await Promise.allSettled([a, b]);
		f.close();
	}
}
console.log("PASS registered control cancels only its in-flight run; session shutdown aborts and joins owned work, not foreign owners");

for (const mode of ["aborted", "probe-error", "close-error", "missing", "deferred-abort", "deferred-success"]) {
	const f = batchFixture();
	const record = durableRun(f.root, `cleanup-${mode}`);
	const controller = new AbortController();
	const focus = Promise.withResolvers();
	const errors = [];
	const calls = [];
	if (mode === "aborted") controller.abort(new Error("parent gone"));
	const herdr = {
		async isTabFocused() {
			calls.push("probe");
			if (mode === "probe-error") throw new Error("cannot query focus");
			if (mode === "missing") throw new Error("tab_not_found");
			return mode.startsWith("deferred");
		},
		async waitForTabUnfocused(_tab, signal) { calls.push("wait"); await waitGate(focus, signal); },
		async closeTab(_tab, signal) {
			calls.push(["close", signal]);
			if (mode === "close-error") throw new Error("cannot close tab");
		},
	};
	try {
		const result = await cleanupRunTab({ herdr, tabId: record.run.tabId, runFile: record.runFile, runRecord: record.run, signal: controller.signal, onError: (error) => errors.push(error) });
		if (result.deferred) {
			assert.deepEqual(readJson(record.runFile).cleanupPendingTabIds, [record.run.tabId]);
			writeJson(record.runFile, { ...readJson(record.runFile), concurrentField: "keep me" });
			if (mode === "deferred-abort") controller.abort(new Error("parent gone during focus wait"));
			else focus.resolve();
			await waitFor(() => !readJson(record.runFile).cleanupPendingTabIds?.length, "durable deferred cleanup commit");
			assert.equal(readJson(record.runFile).concurrentField, "keep me");
		}
		const persisted = readJson(record.runFile);
		assert.equal(persisted.status, "completed", "view cleanup never turns business completion into failure");
		if (["probe-error", "close-error"].includes(mode)) {
			assert.equal(errors.length, 1);
			assert.match(persisted.cleanupError, /cannot/);
			assert.deepEqual(persisted.cleanupPendingTabIds, [record.run.tabId]);
		} else {
			assert.equal(errors.length, 0);
			assert.equal(persisted.cleanupError, undefined);
			assert.ok(!persisted.cleanupPendingTabIds?.length);
		}
		if (mode === "aborted") assert.deepEqual(calls, [["close", undefined]], "already aborted skips focus and force closes without an aborted signal");
		if (mode === "deferred-abort") assert.deepEqual(calls.at(-1), ["close", undefined]);
		if (mode === "missing") assert.deepEqual(calls, ["probe"], "a missing tab is already cleaned");
	} finally { focus.resolve(); f.close(); }
}
console.log("PASS forced/deferred cancellation, focus/close errors, missing tabs and concurrent run-field preservation");

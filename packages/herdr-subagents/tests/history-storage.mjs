import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanSubagentRun, ensureRuntimeIgnored, historyText, listSubagentHistory } from "../src/history.ts";
import { getSubagentRunStatus, runStatusText } from "../src/status.ts";
import { executeHerdrSubagentsControl } from "../src/tool.ts";
import { readTaskRecord } from "../src/records.ts";
import { acquireDirectoryLock, withRunStateLock } from "../src/run-state.ts";
import { writeJsonAtomic } from "../src/state.ts";
import { batchFixture, durableRun, readJson, writeJson } from "./fixtures/herdr.mjs";

const f = batchFixture();
try {
	const first = durableRun(f.root, "selected-one");
	const second = durableRun(f.root, "selected-two");
	writeFileSync(join(first.taskDirectory, "result.md"), "PRIVATE FULL RESULT MUST NOT ENTER PARENT CONTEXT");
	const snapshot = await getSubagentRunStatus(f.root, "selected-one");
	assert.equal(snapshot.runId, "selected-one");
	assert.equal(snapshot.tasks[0].summary, "selected-one summary");
	assert.equal(await getSubagentRunStatus(f.root, "unknown-run"), undefined);
	assert.doesNotMatch(runStatusText(snapshot), /PRIVATE FULL RESULT/);
	const history = await listSubagentHistory(f.root);
	assert.doesNotMatch(historyText(history), /PRIVATE FULL RESULT/);
	const active = durableRun(f.root, "active-run", "running");
	writeJson(join(active.taskDirectory, "report.json"), { status: "completed", summary: "STALE OLD SUMMARY", documents: [] });
	assert.equal((await getSubagentRunStatus(f.root, "active-run")).tasks[0].summary, undefined);
	for (const status of ["starting", "queued", "running", "blocked"]) {
		const item = durableRun(f.root, `active-${status}`, status);
		await assert.rejects(cleanSubagentRun(f.root, item.run.id), /still active/);
		assert.ok(existsSync(item.runFile));
	}
	const activeCorrupt = durableRun(f.root, "active-corrupt-task", "running");
	writeFileSync(activeCorrupt.taskFile, "{broken");
	await assert.rejects(cleanSubagentRun(f.root, "active-corrupt-task"), /still active/, "a damaged history projection must not authorize deleting an active run");
	assert.ok(existsSync(activeCorrupt.runFile));
	const pending = durableRun(f.root, "pending-run", "completed", { cleanupPendingTabIds: ["pending-tab"] });
	await assert.rejects(cleanSubagentRun(f.root, "pending-run"), /waiting to clean up/);
	assert.ok(existsSync(pending.runFile));
	assert.equal(await cleanSubagentRun(f.root, "selected-one"), true);
	assert.equal(existsSync(first.directory), false);
	assert.ok(existsSync(second.runFile));
	assert.equal(await cleanSubagentRun(f.root, "unknown-run"), false);
	console.log("PASS exact status selection, stale-report isolation, compact history and active/pending deletion protection");

	const cleanup = (runId) => executeHerdrSubagentsControl({ action: "cleanup", runId }, undefined, undefined, { cwd: f.root }, {
		agentsDirectory: join(f.root, "no-agents"),
		configurationPaths: { globalConfig: join(f.root, "no-global.json"), projectConfig: join(f.root, "no-project.json") },
	});
	const selected = durableRun(f.root, "public-selected");
	assert.equal((await cleanup("public-selected")).details.cleaned, true);
	assert.equal(existsSync(selected.directory), false);
	assert.ok(existsSync(second.directory), "public cleanup must preserve other runs");
	for (const status of ["running", "completed"]) {
		const corrupt = durableRun(f.root, `public-corrupt-${status}`, status);
		writeFileSync(corrupt.taskFile, "{broken");
		assert.equal((await cleanup(corrupt.run.id)).isError, true);
		assert.ok(existsSync(corrupt.runFile), "public cleanup must retain its safe failure on damaged records");
	}
	assert.equal((await cleanup(pending.run.id)).isError, true);
	assert.ok(existsSync(pending.runFile));
	console.log("PASS public cleanup selection, damaged-record safe failure and pending-tab refusal");

	const brokenRun = durableRun(f.root, "bad-run");
	writeFileSync(brokenRun.runFile, "{broken");
	const brokenTask = durableRun(f.root, "bad-task");
	writeFileSync(brokenTask.taskFile, "{broken");
	const brokenReport = durableRun(f.root, "bad-report");
	writeFileSync(join(brokenReport.taskDirectory, "report.json"), "{broken");
	const healthy = (await listSubagentHistory(f.root));
	assert.ok(healthy.some((run) => run.id === "selected-two" && run.status === "completed"));
	for (const id of ["bad-run", "bad-task", "bad-report"]) {
		const run = healthy.find((candidate) => candidate.id === id);
		assert.equal(run.tasks[0].status, "failed");
		assert.match(run.tasks[0].summary, /Invalid|Could not read/);
	}
	for (const order of [0, -1, 1.5, "1"]) {
		writeJson(brokenTask.taskFile, { ...brokenTask.task, order });
		await assert.rejects(readTaskRecord(brokenTask.taskFile), /Invalid task order/);
	}
	console.log("PASS damaged history retains healthy neighbours and rejects invalid durable task order");

	const snapshotFile = join(f.root, "atomic.json");
	await Promise.all(Array.from({ length: 20 }, (_, index) => writeJsonAtomic(snapshotFile, { index, payload: "x".repeat(2048) })));
	const atomic = readJson(snapshotFile);
	assert.ok(Number.isInteger(atomic.index));
	assert.equal(atomic.payload.length, 2048);
	assert.equal(readdirSync(f.root).filter((name) => name.includes(".tmp-")).length, 0);
	const lockPath = join(f.root, "publish.lock");
	const staged = Promise.withResolvers();
	const publish = Promise.withResolvers();
	const firstLock = acquireDirectoryLock(lockPath, { wait: false, beforePublish: () => { staged.resolve(); return publish.promise; } });
	const firstOutcome = firstLock.then((lock) => ({ lock }), (error) => ({ error }));
	await staged.promise;
	const winner = await acquireDirectoryLock(lockPath, { wait: false });
	publish.resolve();
	assert.match((await firstOutcome).error.message, /already held/);
	assert.equal(readJson(join(lockPath, "owner.json")).token, winner.token);
	await assert.rejects(acquireDirectoryLock(lockPath, { wait: false }), /already held/);
	const controller = new AbortController();
	await assert.rejects(acquireDirectoryLock(lockPath, {
		wait: true, signal: controller.signal, beforePublish: () => controller.abort(new Error("cancelled lock acquisition")),
	}), /cancelled lock acquisition/);
	await winner.release();
	const next = await acquireDirectoryLock(lockPath, { wait: false });
	await winner.release();
	assert.equal(readJson(join(lockPath, "owner.json")).token, next.token, "old release cannot remove the next owner");
	await next.release();
	assert.equal(readdirSync(f.root).filter((name) => name.includes(".initializing-") || name.includes(".released-")).length, 0);

	const runFile = second.runFile;
	const entered = Promise.withResolvers();
	const release = Promise.withResolvers();
	const updateA = withRunStateLock(runFile, undefined, async (run) => { entered.resolve(); await release.promise; run.firstField = "retained"; });
	await entered.promise;
	const updateB = withRunStateLock(runFile, undefined, (run) => { run.secondField = "also retained"; });
	release.resolve();
	await Promise.all([updateA, updateB]);
	assert.deepEqual([readJson(runFile).firstField, readJson(runFile).secondField], ["retained", "also retained"]);
	console.log("PASS atomic snapshots, lock publication exclusivity, cancellation, token-safe release and serialized field preservation");

	for (const gitRepository of [false, true]) {
		const root = join(f.root, gitRepository ? "git-project" : "plain-project");
		mkdirSync(join(root, ".pi"), { recursive: true });
		if (gitRepository) execFileSync("git", ["init", "-q", root]);
		const ignore = gitRepository ? join(root, ".git", "info", "exclude") : join(root, ".pi", ".gitignore");
		writeFileSync(ignore, "unrelated-rule");
		await ensureRuntimeIgnored(root);
		await ensureRuntimeIgnored(root);
		const content = readFileSync(ignore, "utf8");
		assert.ok(content.startsWith("unrelated-rule\n"));
		assert.equal(content.split("\n").filter((line) => line.endsWith("herdr-subagents/runs/")).length, 1);
		assert.ok(!content.includes("herdr-subagents/agents"));
		if (gitRepository) {
			assert.equal(spawnSync("git", ["check-ignore", ".pi/herdr-subagents/runs/run/run.json"], { cwd: root }).status, 0);
			assert.equal(spawnSync("git", ["check-ignore", ".pi/herdr-subagents/agents/reviewer.md"], { cwd: root }).status, 1);
		}
	}
	console.log("PASS runtime ignore is idempotent and preserves unrelated rules and tracked Persona sources");
} finally { f.close(); }

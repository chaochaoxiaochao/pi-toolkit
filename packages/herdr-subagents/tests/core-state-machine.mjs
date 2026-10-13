import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runHerdrSubagentsBatch } from "../src/batch-runner.ts";
import { applyTaskStatus } from "../src/records.ts";

process.env.HERDR_ENV = "1";
process.env.HERDR_WORKSPACE_ID = "test-workspace";

const root = mkdtempSync(join(tmpdir(), "herdr-state-machine-"));

function task(name, prompt, access = "read") {
	return { name, prompt, agent: "worker", access, skills: [], systemPrompt: "Finish the delegated task." };
}

function fakeHerdr() {
	let pane = 0;
	let active = 0;
	let maxActive = 0;
	const alive = new Map();
	const starts = [];
	const paneDirectories = new Map();
	const agents = new Map();
	const publish = (directory, report) => {
		const record = JSON.parse(readFileSync(join(directory, "task.json"), "utf8"));
		const path = join(directory, "reports", `${record.currentAttemptId}.json`);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ attemptId: record.currentAttemptId, documents: [], reportedAt: new Date().toISOString(), ...report }));
	};
	return {
		get maxActive() { return maxActive; },
		starts,
		async createTab(request) {
			pane += 1;
			const paneId = `pane-${pane}`;
			paneDirectories.set(paneId, request.env.PI_HERDR_SUBAGENTS_TASK_DIR);
			return { tabId: "tab-1", paneId };
		},
		async splitPane(request) {
			pane += 1;
			const paneId = `pane-${pane}`;
			paneDirectories.set(paneId, request.env.PI_HERDR_SUBAGENTS_TASK_DIR);
			return { paneId };
		},
		async startAgent(request) {
			const session = request.args[request.args.indexOf("--session") + 1];
			const directory = dirname(session);
			assert.equal(paneDirectories.get(request.paneId), directory);
			assert.equal(request.args.includes("--print"), false);
			alive.set(request.paneId, true);
			agents.set(request.name, { paneId: request.paneId, directory });
		},
		async promptAgent(request) {
			const { paneId, directory } = agents.get(request.target);
			starts.push(request.prompt);
			active += 1;
			maxActive = Math.max(maxActive, active);
			if (request.prompt.includes("transport retry")) {
				setTimeout(() => {
					publish(directory, { status: "completed", summary: `${request.prompt} result` });
					alive.set(paneId, false);
					active -= 1;
				}, 35);
				throw new Error("WebSocket closed 1000");
			}
			await new Promise((resolve) => setTimeout(resolve, request.prompt.includes("slow") ? 35 : 10));
			if (!request.prompt.includes("omit report")) publish(directory, {
				status: request.prompt.includes("fail") ? "failed" : "completed",
				summary: `${request.prompt} result`,
				...(request.prompt.includes("fail") ? { error: "expected failure" } : {}),
			});
			alive.set(paneId, false);
			active -= 1;
			return { status: "done" };
		},
		async getAgentState() { return "unknown"; },
		async waitForAgentChange() { await new Promise((resolve) => setTimeout(resolve, 5)); },
		async isTaskRunning(paneId) { return alive.get(paneId) === true; },
		async renamePane() {}, async renameTab() {}, async focusPane() {},
		async isTabFocused() { return false; }, async waitForTabUnfocused() {},
		async paneExists() { return true; }, async closeTab() {},
	};
}

async function run(tasks, concurrency, herdr = fakeHerdr()) {
	const result = await runHerdrSubagentsBatch(tasks, {
		label: "state-machine-test", concurrency, maxConcurrency: 4, cwd: root, herdr,
	});
	return { result, herdr };
}

{
	const { result, herdr } = await run([task("one", "first slow"), task("two", "second")], 1);
	assert.equal(result.status, "completed");
	assert.equal(herdr.maxActive, 1);
	assert.deepEqual(herdr.starts, ["first slow", "second"]);
	assert.deepEqual(result.tasks.map((entry) => entry.status), ["completed", "completed"]);
}

{
	const { result, herdr } = await run([task("one", "one slow"), task("two", "two slow"), task("three", "three")], 2);
	assert.equal(result.status, "completed");
	assert.equal(herdr.maxActive, 2);
	assert.deepEqual(result.tasks.map((entry) => entry.index), [0, 1, 2]);
}

{
	const { result } = await run([task("retry", "retry slow")], 1);
	assert.equal(result.status, "completed");
	assert.equal(result.tasks[0].summary, "retry slow result");
}


{
	const { result } = await run([task("retry", "transport retry")], 1);
	assert.equal(result.status, "completed");
	assert.equal(result.tasks[0].summary, "transport retry result");
}

{
	const { result } = await run([task("missing", "omit report")], 1);
	assert.equal(result.status, "failed");
	assert.match(result.tasks[0].error, /exited without submitting/);
}

{
	const { result } = await run([task("bad", "fail"), task("good", "still run")], 2);
	assert.equal(result.status, "partial");
	assert.deepEqual(result.tasks.map((entry) => entry.status), ["failed", "completed"]);
}

await assert.rejects(() => run([task("writer", "edit", "write"), task("reader", "read")], 2), /require concurrency 1/);

const terminal = { id: "task", runId: "run", order: 1, status: "completed" };
assert.throws(() => applyTaskStatus(terminal, "running"), /terminal tasks are immutable/);

console.log("PASS core Herdr state machine");

import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { executeHerdrSubagentsControl } from "../src/tool.ts";
import { registerHerdrSubagents } from "../extensions/herdr-subagents.ts";
import { batchFixture, durableRun } from "./fixtures/herdr.mjs";

const f = batchFixture();
try {
	const dependencies = { agentsDirectory: join(f.root, "no-agents"), configurationPaths: { globalConfig: join(f.root, "none"), projectConfig: join(f.root, "none") } };
	const control = (params) => executeHerdrSubagentsControl(params, undefined, undefined, { cwd: f.root }, dependencies);
	assert.deepEqual((await control({ action: "history" })).details, { action: "history", runs: [], hasMore: false });
	for (let i = 0; i < 61; i++) durableRun(f.root, `run-${String(i).padStart(2, "0")}`);
	const first = await control({ action: "history" });
	assert.equal(first.details.runs.length, 10);
	assert.equal(first.details.hasMore, true);
	assert.deepEqual(first.details.runs.map((run) => run.id), ["run-60", "run-59", "run-58", "run-57", "run-56", "run-55", "run-54", "run-53", "run-52", "run-51"]);
	assert.equal(first.details.runs[0].taskCount, 1);
	assert.doesNotMatch(JSON.stringify(first), /summary|sessionFile|recordDirectory|result\.md/);
	assert.match(first.content[0].text, /nextCursor/);
	const oldEnv = { HERDR_ENV: process.env.HERDR_ENV, HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID, PI_HERDR_SUBAGENTS_CHILD: process.env.PI_HERDR_SUBAGENTS_CHILD };
	try {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_WORKSPACE_ID = "history-fixture";
		delete process.env.PI_HERDR_SUBAGENTS_CHILD;
		let command;
		registerHerdrSubagents({ on() {}, registerTool() {}, registerCommand(_name, definition) { command = definition; } }, {
			configurationCwd: f.root, configurationPaths: dependencies.configurationPaths,
		});
		const notices = [];
		const ctx = { cwd: f.root, ui: { notify: (text, level) => notices.push({ text, level }) } };
		await command.handler("history", ctx);
		assert.match(notices.at(-1).text, /run-60/);
		assert.doesNotMatch(notices.at(-1).text, /run-50/);
		assert.ok(notices.at(-1).text.includes(`/herdr-subagents history ${first.details.nextCursor}`));
		await command.handler(`history ${first.details.nextCursor}`, ctx);
		assert.match(notices.at(-1).text, /run-50/);
		assert.doesNotMatch(notices.at(-1).text, /run-60/);
		await command.handler("history invalid", ctx);
		assert.equal(notices.at(-1).level, "error");
	} finally {
		for (const [key, value] of Object.entries(oldEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	durableRun(f.root, "newer", "completed", { startedAt: "2026-11-01T00:00:00Z" });
	rmSync(join(f.root, ".pi/herdr-subagents/runs/run-51"), { recursive: true });
	const second = await control({ action: "history", limit: 50, cursor: first.details.nextCursor });
	assert.equal(second.details.runs.length, 50);
	assert.equal(second.details.runs[0].id, "run-50");
	const last = await control({ action: "history", cursor: second.details.nextCursor });
	assert.equal(last.details.runs.length, 1);
	assert.equal(last.details.runs[0].id, "run-00");
	assert.equal(last.details.hasMore, false);
	assert.equal(last.details.nextCursor, undefined);
	const status = await control({ action: "status", runId: "run-60" });
	assert.equal(status.details.tasks[0].summary, "run-60 summary");
	writeFileSync(join(f.root, ".pi/herdr-subagents/runs/run-60/tasks/01-task/report.json"), "{broken");
	assert.equal((await control({ action: "history" })).details.runs.find((run) => run.id === "run-60").status, "completed", "index uses run metadata, not every task report");
	for (const params of [
		{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: "10" }, { limit: null }, { cursor: "" }, { cursor: "invalid" }, { cursor: null },
		{ cursor: Buffer.from("{}").toString("base64url") }, { cursor: "x".repeat(2048) },
	]) assert.equal((await control({ action: "history", ...params })).isError, true, JSON.stringify(params));
	assert.equal((await control({ action: "list", limit: 10 })).isError, true);
	const broken = durableRun(f.root, "broken");
	writeFileSync(broken.runFile, "{broken");
	durableRun(f.root, "legacy", "completed", { taskIds: undefined });
	const all = [];
	let cursor;
	do {
		const response = await control({ action: "history", limit: 50, ...(cursor ? { cursor } : {}) });
		assert.notEqual(response.isError, true);
		all.push(...response.details.runs);
		cursor = response.details.nextCursor;
	} while (cursor);
	assert.equal(all.find((run) => run.id === "broken").status, "failed");
	assert.match(all.find((run) => run.id === "broken").error, /Invalid run metadata/);
	assert.equal(all.find((run) => run.id === "legacy").taskCount, null);
	console.log("PASS compact cursor history, stable pagination during insertion, on-demand summaries and invalid-page safety");
} finally { f.close(); }

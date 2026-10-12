import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeHerdrSubagents } from "../src/tool.ts";
import { CliHerdrAutomation } from "../src/herdr.ts";

if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) {
	throw new Error("The real Herdr smoke test must run from a Pi session inside Herdr.");
}

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "pi-herdr-subagents-real-"));
const herdr = new CliHerdrAutomation();
const tabIds = new Set();
const model = process.env.HERDR_SUBAGENTS_E2E_MODEL?.trim();
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

async function runCase(label, names, concurrency) {
	const response = await executeHerdrSubagents({
		label,
		concurrency,
		tasks: names.map((name) => ({
			name,
			agent: "analyst",
			...(model ? { model } : {}),
			prompt: `Do not inspect files. Call subagent_report with status completed, summary '${name} completed', and result 'hello'.`,
		})),
	}, timeout, (update) => {
		if (update.details?.tabId) tabIds.add(update.details.tabId);
	}, { cwd: root }, {
		agentsDirectory: join(packageDirectory, "agents"),
		configurationPaths,
		herdr,
	});

	const result = response.details;
	if (result?.tabId) tabIds.add(result.tabId);
	assert.equal(response.isError, undefined, response.content?.[0]?.text);
	assert.equal(result.status, "completed");
	assert.equal(result.effectiveConcurrency, concurrency);
	assert.equal(result.tasks.length, names.length);
	assert.equal(new Set(result.tasks.map((task) => task.paneId)).size, names.length);

	for (const taskResult of result.tasks) {
		const task = JSON.parse(readFileSync(join(taskResult.recordDirectory, "task.json"), "utf8"));
		const report = JSON.parse(readFileSync(join(taskResult.recordDirectory, "report.json"), "utf8"));
		assert.equal(task.status, "completed");
		assert.equal(report.status, "completed");
		assert.equal(report.attemptId, task.currentAttemptId);
		assert.equal(hasAssistantMessage(task.sessionFile), true, `${taskResult.name} produced no assistant event`);
		assert.equal(await herdr.paneExists(task.paneId), false, `${taskResult.name} pane survived tab cleanup`);
	}
	console.log(`PASS ${label}: ${names.length} real child Agent${names.length === 1 ? "" : "s"} completed and cleaned up`);
}

try {
	await runCase("real-single", ["hello-single"], 1);
	await runCase("real-concurrent", ["hello-one", "hello-two"], 2);
} finally {
	for (const tabId of tabIds) await herdr.closeTab(tabId).catch(() => undefined);
	rmSync(root, { recursive: true, force: true });
}

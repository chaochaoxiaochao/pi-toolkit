import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHerdrSubagentsBatch } from "../src/batch-runner.ts";
import registerSubagentReport from "../extensions/subagent-report.ts";
import { normalizeHerdrSubagentsArguments, registerHerdrSubagents } from "../extensions/herdr-subagents.ts";
import { applyTaskStatus } from "../src/records.ts";
import { executeHerdrSubagents, executeHerdrSubagentsControl } from "../src/tool.ts";

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

async function run(tasks, concurrency, herdr = fakeHerdr(), signal) {
	const result = await runHerdrSubagentsBatch(tasks, {
		label: "state-machine-test", concurrency, maxConcurrency: 4, cwd: root, herdr, signal,
	});
	return { result, herdr };
}

{
	const herdr = fakeHerdr();
	const execute = (params) => executeHerdrSubagents(params, undefined, undefined, { cwd: root }, {
		agentsDirectory: fileURLToPath(new URL("../agents/", import.meta.url)),
		configurationPaths: { globalConfig: join(root, "global-config.json") },
		herdr,
	});
	const listed = await executeHerdrSubagentsControl({ action: "list" }, undefined, undefined, { cwd: root }, {
		agentsDirectory: fileURLToPath(new URL("../agents/", import.meta.url)),
		configurationPaths: { globalConfig: join(root, "global-config.json") },
	});
	const personas = new Map(listed.details.agents.map((persona) => [persona.name, persona]));
	const analyst = personas.get("analyst");
	assert.match(analyst.description, /agent-team.*roles defined by each task/);
	assert.match(analyst.systemPrompt, /role charter and evaluation method/);
	const reviewer = personas.get("reviewer");
	assert.match(reviewer.description, /proposals, designs, documents, implementations, and analysis/);
	assert.match(reviewer.systemPrompt, /goals and constraints/);
	assert.match(reviewer.systemPrompt, /assumptions, logic, evidence, trade-offs, and risks/);
	const explorer = personas.get("explorer");
	assert.match(explorer.description, /codebase structure, behavior, and dependencies/);
	assert.match(explorer.systemPrompt, /Locate relevant files, trace behavior and dependencies/);
	const readTools = ["read", "bash", "grep", "find", "ls", "codemode"];
	for (const name of ["analyst", "reviewer", "explorer"]) {
		const persona = personas.get(name);
		assert.equal(persona.access, "read");
		assert.deepEqual(persona.tools, readTools);
		assert.ok(listed.content[0].text.includes(`${name}: ${persona.description}`), "The parent must see role selection guidance in Persona listings");
		assert.ok(!listed.content[0].text.includes(persona.systemPrompt), "Persona listings must not embed the child instructions");
	}
	assert.equal(personas.get("worker").access, "write");
	assert.equal(personas.get("worker").description, "General-purpose worker for one focused task");
	assert.match(personas.get("worker").systemPrompt, /Do not delegate to another agent/);
	const missing = { name: "review", prompt: "Read-only review" };
	for (const params of [
		{ tasks: [missing] },
		...["", " \t", null, 42].map((agent) => ({ tasks: [{ ...missing, agent }] })),
		normalizeHerdrSubagentsArguments({ prompt: "Read-only review" }),
		normalizeHerdrSubagentsArguments({ prompt: "Read-only review", agent: 42 }),
	]) {
		const response = await execute(params);
		assert.equal(response.isError, true, "Missing or invalid agent must not silently select worker");
		assert.match(response.content[0].text, /tasks\[0\]\.agent.*required/);
	}
	const laterMissing = await execute({ tasks: [{ ...missing, agent: "analyst" }, missing], concurrency: 2 });
	assert.match(laterMissing.content[0].text, /tasks\[1\]\.agent.*required/);
	const unknown = await execute({ tasks: [{ ...missing, agent: "unknown-persona" }] });
	assert.equal(unknown.isError, true);
	assert.equal(unknown.content[0].text, `Unknown persona 'unknown-persona'.\n\n${listed.content[0].text}`, "Unknown-Persona errors must reuse the concise selection list");
	assert.deepEqual(herdr.starts, [], "Invalid requests must not start an Agent");
	assert.equal(existsSync(join(root, ".pi", "herdr-subagents", "runs")), false, "Invalid requests must not create run records");

	const serial = await execute(normalizeHerdrSubagentsArguments({ prompt: "make change", agent: "worker" }));
	assert.equal(serial.details.status, "completed", "Explicit worker must still run serially through legacy argument normalization");
	const parallel = await execute({ tasks: ["analyst", "reviewer", "explorer"].map((agent) => ({ ...missing, agent })), concurrency: 2 });
	assert.equal(parallel.details.status, "completed");
	assert.equal(parallel.details.effectiveConcurrency, 2);
	for (const [index, name] of ["analyst", "reviewer", "explorer"].entries()) {
		const directory = parallel.details.tasks[index].recordDirectory;
		const instructions = readFileSync(join(directory, "system-prompt.md"), "utf8");
		assert.ok(instructions.startsWith(personas.get(name).systemPrompt), "Each child must receive its selected Persona body");
		assert.ok(instructions.includes("Submit your final answer by calling the subagent_report tool."));
		assert.doesNotMatch(instructions, /process exits/);
	}

	const projectAgents = join(root, ".pi", "herdr-subagents", "agents");
	mkdirSync(projectAgents, { recursive: true });
	writeFileSync(join(projectAgents, "auditor.md"), "---\nname: auditor\ndescription: Custom read-only reviewer\naccess: read\n---\nReview the task.\n");
	const custom = await execute({ tasks: [{ ...missing, agent: " auditor " }], concurrency: 2 });
	assert.equal(custom.details.status, "completed", "Custom Persona names must remain valid and trim whitespace");
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

{
	const { result } = await run([task("bad-one", "fail one"), task("bad-two", "fail two")], 2);
	assert.equal(result.status, "failed");
	assert.deepEqual(result.tasks.map((entry) => entry.status), ["failed", "failed"]);
}

{
	const controller = new AbortController();
	setTimeout(() => controller.abort(new Error("test cancellation")), 8);
	const { result } = await run([task("active", "slow active"), task("queued", "queued")], 1, fakeHerdr(), controller.signal);
	assert.equal(result.status, "cancelled");
	assert.deepEqual(result.activity.map((entry) => entry.status), ["cancelled", "cancelled"]);
}

await assert.rejects(() => run([task("writer", "edit", "write"), task("reader", "read")], 2), (error) => {
	assert.match(error.message, /writer.*worker/);
	assert.match(error.message, /concurrency: 1/);
	assert.match(error.message, /read-only Persona/);
	return true;
});

const terminal = { id: "task", runId: "run", order: 1, status: "completed" };
assert.throws(() => applyTaskStatus(terminal, "running"), /terminal tasks are immutable/);

{
	const lifecycleRoot = join(root, "startup-history-isolation");
	const runDirectory = join(lifecycleRoot, ".pi", "herdr-subagents", "runs", "historical-run");
	const taskDirectory = join(runDirectory, "tasks", "01-task");
	mkdirSync(taskDirectory, { recursive: true });
	const historicalRun = { id: "historical-run", label: "historical", status: "completed", ownerSessionId: "old-session", ownerProcessId: 99999999, tabId: "w1:t-reused", taskIds: ["historical-task"], completedAt: "2026-10-01T00:00:00.000Z" };
	writeFileSync(join(runDirectory, "run.json"), JSON.stringify(historicalRun));
	writeFileSync(join(taskDirectory, "task.json"), JSON.stringify({ id: "historical-task", runId: "historical-run", order: 1, status: "completed", completedAt: historicalRun.completedAt }));
	const configurationPaths = { globalConfig: join(lifecycleRoot, "global-config.json") };
	const events = new Map();
	const registeredTools = new Map();
	const herdrCalls = [];
	registerHerdrSubagents({
		on(name, handler) { events.set(name, handler); },
		registerTool(tool) { registeredTools.set(tool.name, tool); },
		registerCommand() {},
	}, {
		herdr: {
			async isTabFocused(tabId) { herdrCalls.push(["isTabFocused", tabId]); return false; },
			async closeTab(tabId) { herdrCalls.push(["closeTab", tabId]); },
		},
		isEditor: () => false,
		configurationCwd: lifecycleRoot,
		configurationPaths,
	});
	await events.get("session_start")?.({}, {
		cwd: lifecycleRoot,
		mode: "rpc",
		sessionManager: { getSessionId: () => "new-session" },
		ui: { notify() {} },
	});
	assert.deepEqual(herdrCalls, [], "Pi startup must not inspect or close historical Subagent tabs");
	assert.deepEqual(JSON.parse(readFileSync(join(runDirectory, "run.json"), "utf8")), historicalRun, "Pi startup must not mutate historical Subagent records");
	const taskSchema = registeredTools.get("herdr_subagents").parameters.properties.tasks.items;
	const description = registeredTools.get("herdr_subagents").description;
	assert.match(description, /reviewer for independent reviews/);
	assert.match(description, /explorer for codebase investigation/);
	assert.match(description, /worker for file changes/);
	assert.match(description, /analyst for agent-team/);
	assert.ok(taskSchema.required.includes("agent"), "The model-facing schema must require agent");
	assert.equal(taskSchema.properties.agent.enum, undefined, "Custom Persona names must remain valid");
	assert.equal(registeredTools.get("herdr_subagents")?.exposure, undefined, "Unconfigured Subagent execution must inherit Pi's exposure default");
	assert.equal(registeredTools.get("herdr_subagents_control")?.exposure, undefined, "Unconfigured Subagent control must inherit Pi's exposure default");
	mkdirSync(join(lifecycleRoot, ".pi"), { recursive: true });
	writeFileSync(join(lifecycleRoot, ".pi", "herdr-subagents.json"), JSON.stringify({ exposure: "model-only", defaultExtensions: [] }));
	const configuredTools = new Map();
	const configuredCommands = new Map();
	registerHerdrSubagents({
		on() {},
		registerTool(tool) { configuredTools.set(tool.name, tool); },
		registerCommand(name, command) { configuredCommands.set(name, command); },
	}, { herdr: {}, isEditor: () => false, configurationCwd: lifecycleRoot, configurationPaths });
	assert.equal(configuredTools.get("herdr_subagents")?.exposure, "model-only", "Project configuration can exclude Subagent execution from Codemode");
	assert.equal(configuredTools.get("herdr_subagents_control")?.exposure, "model-only", "Project configuration applies consistently to both Subagent tools");
	const notifications = [];
	await configuredCommands.get("herdr-subagents").handler("settings", { cwd: lifecycleRoot, ui: { notify(message) { notifications.push(message); } } });
	assert.match(notifications[0], /defaultExtensions=\[\] \(project\)/, "Settings must show empty defaults and their source");
	await configuredCommands.get("herdr-subagents").handler("agents", { cwd: lifecycleRoot, ui: { notify(message) { notifications.push(message); } } });
	assert.match(notifications[1], /: (?:package|global|project), (?:read|write), model=.*thinking=.*tools=.*skills=.*extensions=/, "User-facing inspection must retain detailed configuration fields");
}

{
	const previousParent = process.env.PI_HERDR_SUBAGENTS_PARENT_PANE_ID;
	process.env.PI_HERDR_SUBAGENTS_PARENT_PANE_ID = "test-workspace:parent";
	const handlers = new Map();
	const commands = new Map();
	const shortcuts = new Map();
	const calls = [];
	const statuses = new Map([
		["herdr-subagents-parent", "alt+p parent"],
		["codex-edit", "editor: apply_patch"],
	]);
	const ctx = { ui: { notify() {}, setStatus(key, value) { statuses.set(key, value); } } };
	try {
		registerSubagentReport({
			registerTool() {},
			registerCommand(name, command) { commands.set(name, command); },
			registerShortcut(key, shortcut) { shortcuts.set(key, shortcut); },
			on(name, handler) { handlers.set(name, handler); },
			events: { on() {} },
			async exec(command, args) { calls.push([command, args]); return { code: 0, stdout: "", stderr: "" }; },
		});
		await handlers.get("session_start")({}, ctx);
		assert.equal(statuses.get("herdr-subagents-parent"), undefined, "child startup clears the old parent shortcut hint");
		assert.equal(statuses.get("codex-edit"), "editor: apply_patch", "child navigation must not overwrite editor status");
		await commands.get("parent").handler("", ctx);
		await shortcuts.get("alt+p").handler(ctx);
		assert.deepEqual(calls, [
			["herdr", ["agent", "focus", "test-workspace:parent"]],
			["herdr", ["agent", "focus", "test-workspace:parent"]],
		], "the parent command and shortcut must remain functional without a footer hint");
	} finally {
		if (previousParent === undefined) delete process.env.PI_HERDR_SUBAGENTS_PARENT_PANE_ID;
		else process.env.PI_HERDR_SUBAGENTS_PARENT_PANE_ID = previousParent;
	}
}

{
	const directory = join(root, "report-idempotency");
	mkdirSync(directory, { recursive: true });
	const attemptId = "11111111-1111-4111-8111-111111111111";
	writeFileSync(join(directory, "task.json"), JSON.stringify({ id: "task", runId: "run", order: 1, status: "running", currentAttemptId: attemptId }));
	const handlers = new Map();
	let reportTool;
	registerSubagentReport({
		registerTool(tool) { reportTool = tool; },
		registerCommand() {}, registerShortcut() {},
		on(name, handler) { handlers.set(name, handler); },
		events: { on() {} },
		async exec() { return { code: 0, stdout: "", stderr: "", killed: false }; },
	});
	process.env.PI_HERDR_SUBAGENTS_TASK_DIR = directory;
	await handlers.get("before_agent_start")?.();
	const report = { status: "completed", summary: "done", result: "full result", documents: [] };
	await reportTool.execute("first", report);
	await reportTool.execute("duplicate", report);
	await assert.rejects(() => reportTool.execute("conflict", { ...report, summary: "different" }), /Conflicting subagent_report/);
	const originalExit = process.exit;
	let exitCode;
	process.exit = (code) => { exitCode = code; };
	try {
		await handlers.get("agent_settled")?.({}, { isIdle: () => true });
		await new Promise((resolve) => setTimeout(resolve, 40));
	} finally {
		process.exit = originalExit;
	}
	assert.equal(exitCode, undefined, "settled child must remain alive for focus-aware tab cleanup");
	const attempt = JSON.parse(readFileSync(join(directory, "attempts", `${attemptId}.json`), "utf8"));
	assert.equal(attempt.state, "settled");
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const renderedCall = reportTool.renderCall({ ...report, result: "FULL RESULT MUST NOT RENDER" }, theme).render(120).join("\n");
	assert.match(renderedCall, /completed.*saved to disk/);
	assert.doesNotMatch(renderedCall, /FULL RESULT MUST NOT RENDER/);
	const renderedResult = reportTool.renderResult(await reportTool.execute("render", report), { isPartial: false }, theme).render(120).join("\n");
	assert.match(renderedResult, /completed.*done/);
	const persisted = JSON.parse(readFileSync(join(directory, "reports", `${attemptId}.json`), "utf8"));
	assert.equal(persisted.summary, "done");
	delete process.env.PI_HERDR_SUBAGENTS_TASK_DIR;
}

console.log("PASS core Herdr state machine");

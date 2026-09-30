import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverPackageAgents, parseAgentMarkdown } from "../src/personas.ts";
import { loadSubagentConfiguration } from "../src/config.ts";
import { runHerdrSubagents } from "../src/runner.ts";
import { executeHerdrSubagents } from "../src/tool.ts";
import { activityCounts, focusActiveTask } from "../src/monitor.ts";
import { RunDispatcher } from "../src/dispatcher.ts";
import { ensureRuntimeIgnored, historyText, listSubagentHistory } from "../src/history.ts";
import { writeJsonAtomic } from "../src/state.ts";
import { loadQueuedRuns, persistQueuedRun } from "../src/queued-runs.ts";
import { reconcileSubagentRuns } from "../src/reconcile.ts";
import { continueQueuedRun } from "../src/continue-run.ts";
import { CliHerdrAutomation } from "../src/herdr.ts";

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
		},
		async promptAgent(request) {
			calls.push(["promptAgent", request]);
			writeFileSync(join(taskDirectory, "session.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: root })}\n`);
			if (mode === "completed" || mode === "close-failed") {
				writeFileSync(join(taskDirectory, "result.md"), "FULL RESULT THAT STAYS OUT OF PARENT CONTEXT");
				writeFileSync(join(taskDirectory, "report.json"), JSON.stringify({
					status: "completed",
					summary: "Authentication review completed.",
					documents: [{ path: join(taskDirectory, "result.md"), description: "Full result" }],
				}));
			} else if (mode === "failed") {
				writeFileSync(join(taskDirectory, "result.md"), "Provider stopped before completing the review.");
				writeFileSync(join(taskDirectory, "report.json"), JSON.stringify({
					status: "failed",
					summary: "Authentication review failed.",
					error: "provider unavailable",
					documents: [],
				}));
			}
			return { status: mode === "failed" ? "done" : "idle" };
		},
		async splitPane(request) {
			calls.push(["splitPane", request]);
			paneSequence += 1;
			return { paneId: `w1:p${paneSequence}` };
		},
		async prepareTask(args) { calls.push(["prepareTask", { args }]); },
		async runTask(request) {
			calls.push(["runTask:start", request]);
			taskRuns += 1;
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, request.prompt.includes("slow") ? 15 : 2));
			if (mode === "stalled") request.onStalled?.();
			if (mode === "post-fail") { active -= 1; throw new Error("connection lost after prompt submission"); }
			const directory = request.env.PI_HERDR_SUBAGENTS_TASK_DIR;
			writeFileSync(join(directory, "session.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: request.marker, cwd: root })}\n`);
			const needsInput = (mode === "blocked" && taskRuns === 1) || (mode === "blocked-twice" && (taskRuns === 1 || taskRuns === 3));
			const failed = request.prompt.includes("FAIL");
			writeFileSync(join(directory, "result.md"), `FULL ${request.prompt}`);
			const question = taskRuns === 3 ? "Which environment should I inspect?" : "Which branch should I inspect?";
			writeFileSync(join(directory, "report.json"), JSON.stringify({ status: needsInput ? "needs-input" : failed ? "failed" : "completed", summary: needsInput ? "Need more input." : failed ? `${request.prompt} failed.` : `${request.prompt} completed.`, ...(needsInput ? { question } : {}), ...(failed ? { error: "expected failure" } : {}), documents: [] }));
			active -= 1;
			calls.push(["runTask:end", request]);
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
	check("Herdr lifecycle", herdr.calls.map(([name]) => name).join(",") === "createTab,startAgent,promptAgent,isTabFocused,closeTab");
	const createRequest = herdr.calls[0][1];
	const startRequest = herdr.calls[1][1];
	check("named unfocused tab in parent workspace", createRequest.workspaceId === "w1" && createRequest.cwd === root && createRequest.label === "SA · auth-review" && createRequest.focus === false);
	check("child environment points at durable task", createRequest.env.PI_HERDR_SUBAGENTS_CHILD === "1" && createRequest.env.PI_HERDR_SUBAGENTS_TASK_DIR.includes(join(".pi", "herdr-subagents", "runs")));
	check("persistent isolated child Pi", startRequest.kind === "pi" && startRequest.paneId === "w1:p2" && startRequest.args.includes("--session") && startRequest.args.includes("--no-extensions") && startRequest.args.includes("--extension") && startRequest.args.includes("--no-skills") && startRequest.args.includes("--model") && startRequest.args.includes("fake/model") && startRequest.args.includes("--tools") && startRequest.args.includes("read,grep,subagent_report"));
	check("prompt submitted through Herdr", herdr.calls[2][1].prompt === "Review authentication" && herdr.calls[2][1].target === startRequest.name);

	const runDirectory = latestRunDirectory();
	const runRecord = JSON.parse(readFileSync(join(runDirectory, "run.json"), "utf8"));
	const taskDirectory = join(runDirectory, "tasks", readdirSync(join(runDirectory, "tasks"))[0]);
	const taskRecord = JSON.parse(readFileSync(join(taskDirectory, "task.json"), "utf8"));
	check("run and task records settle", runRecord.status === "completed" && taskRecord.status === "completed" && taskRecord.prompt === "Review authentication" && taskRecord.model === "fake/model");
	check("full result and session stay on disk", readFileSync(join(taskDirectory, "result.md"), "utf8").startsWith("FULL RESULT") && existsSync(join(taskDirectory, "session.jsonl")));

	const extensionHerdr = fakeHerdr();
	const publicResult = await executeHerdrSubagents({ agent: "worker", prompt: "Review through the public tool" }, undefined, undefined, {
		cwd: root,
		model: { provider: "fake", id: "model" },
		thinkingLevel: "medium",
	}, { agentsDirectory: join(process.cwd(), "agents"), herdr: extensionHerdr });
	check("public extension behavior uses injectable Herdr", !publicResult.isError && publicResult.content[0].text.includes("Authentication review completed.") && !publicResult.content[0].text.includes("FULL RESULT") && extensionHerdr.calls.map(([name]) => name).join(",") === "createTab,startAgent,promptAgent,isTabFocused,closeTab", JSON.stringify({ publicResult, calls: extensionHerdr.calls.map(([name]) => name) }));

	const failedHerdr = fakeHerdr("failed");
	const failedRun = await runHerdrSubagents("Fail cleanly", { cwd: root, herdr: failedHerdr });
	check("structured child failure", !failedRun.ok && failedRun.status === "failed" && failedRun.summary === "Authentication review failed." && failedRun.errorMessage === "provider unavailable" && failedHerdr.calls.at(-1)[0] === "closeTab");

	const silentHerdr = fakeHerdr("silent");
	const silent = await runHerdrSubagents("Forget report", { cwd: root, herdr: silentHerdr });
	check("missing report is visible failure", !silent.ok && silent.errorMessage?.includes("did not submit") && silentHerdr.calls.at(-1)[0] === "closeTab");

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
	writeFileSync(join(globalAgents, "worker.md"), `---\nname: worker\ndescription: Global worker\naccess: read\n---\nGlobal prompt.`);
	writeFileSync(join(projectAgents, "worker.md"), `---\nname: worker\ndescription: Project worker\n---\nProject prompt.`);
	const globalConfig = join(configRoot, "global.json");
	const projectConfig = join(configRoot, "project.json");
	writeFileSync(globalConfig, JSON.stringify({ maxConcurrency: 8, defaultModel: "global/default", personas: { worker: { model: "global/worker", thinking: "low", skills: ["global-skill"] } } }));
	writeFileSync(projectConfig, JSON.stringify({ maxConcurrency: 3, personas: { worker: { model: "project/worker", thinking: "high", skills: ["project-skill"] } } }));
	const configurationPaths = { globalConfig, projectConfig, globalAgents, projectAgents };
	const configuration = loadSubagentConfiguration(configRoot, packageAgents, "parent/model", configurationPaths);
	const configuredWorker = configuration.personas.find((persona) => persona.name === "worker");
	const configuredExplorer = configuration.personas.find((persona) => persona.name === "explorer");
	check("built-in settings recursively merge global then project", configuration.settings.defaultConcurrency === 1 && configuration.settings.maxConcurrency === 3 && configuration.settings.defaultModel === "global/default" && configuration.settingSources.maxConcurrency === "project");
	check("persona definitions use project global package precedence", configuredWorker?.source === "project" && configuredWorker.description === "Project worker" && configuredWorker.systemPrompt === "Project prompt." && configuredWorker.access === "write" && configuredExplorer?.source === "package" && configuredExplorer.access === "read");
	check("persona configuration resolves model thinking and skills", configuredWorker?.model === "project/worker" && configuredWorker.modelSource === "project persona" && configuredWorker.thinking === "high" && configuredWorker.skills.join(",") === "project-skill");
	writeFileSync(projectConfig, JSON.stringify({ personas: { worker: { model: 42, thinking: [], skills: "invalid" } } }));
	const invalidConfiguration = loadSubagentConfiguration(configRoot, packageAgents, "parent/model", configurationPaths);
	const invalidWorker = invalidConfiguration.personas.find((persona) => persona.name === "worker");
	check("invalid persona fields are diagnosed and ignored", invalidWorker?.model === "global/worker" && invalidWorker.thinking === "low" && invalidWorker.skills.join(",") === "global-skill" && invalidConfiguration.diagnostics.filter((message) => message.includes("persona 'worker'")).length === 3);
	writeFileSync(projectConfig, JSON.stringify({ maxConcurrency: 3, personas: { worker: { model: "project/worker", thinking: "high", skills: ["project-skill"] } } }));
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
	const batchRuns = batchHerdr.calls.filter(([name]) => name === "runTask:start").map(([, request]) => request);
	check("read-only batch uses bounded concurrency", batchDetails.effectiveConcurrency === 2 && batchHerdr.maxActive === 2 && batchHerdr.calls.filter(([name]) => name === "splitPane").length === 1);
	check("batch is FIFO and reuses bounded panes", batchRuns.map((request) => request.prompt).join(",") === "one slow,two,three FAIL,four" && new Set(batchRuns.map((request) => request.paneId)).size === 2);
	check("failed sibling does not cancel batch", batch.isError && batchDetails.status === "partial" && batchDetails.tasks.map((task) => task.name).join(",") === "one,two,three,four" && batchDetails.tasks[2].status === "failed" && batchDetails.tasks[3].status === "completed");
	const batchCleanupHerdr = fakeHerdr("close-failed");
	const batchCleanup = await executeHerdrSubagents({ tasks: [{ name: "cleanup", prompt: "cleanup", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: batchCleanupHerdr });
	const batchCleanupRecord = JSON.parse(readFileSync(join(batchCleanup.details.recordDirectory, "run.json"), "utf8"));
	check("batch cleanup failure preserves completed result", !batchCleanup.isError && batchCleanup.details.status === "completed" && batchCleanupRecord.cleanupError.includes("tab still busy"));
	const activeUpdate = batchUpdates.find((update) => update.activity?.some((task) => task.status === "running"));
	const counts = activityCounts(activeUpdate);
	const focusHerdr = fakeHerdr();
	const runningTask = activeUpdate.activity.find((task) => task.status === "running");
	const focused = await focusActiveTask(activeUpdate, runningTask.index + 1, focusHerdr);
	check("active progress exposes widget counts and exact pane navigation", counts.running > 0 && counts.queued > 0 && focused && focusHerdr.calls.at(-1)[0] === "focusPane" && focusHerdr.calls.at(-1)[1].paneId === runningTask.paneId);
	const tabLabels = batchHerdr.calls.filter(([name]) => name === "renameTab").map(([, request]) => request.label);
	const paneLabels = batchHerdr.calls.filter(([name]) => name === "renamePane").map(([, request]) => request.label);
	check("tab and reused panes keep stable progress labels", tabLabels.join(",") === "SA · reviews · 1/4,SA · reviews · 2/4,SA · reviews · 3/4,SA · reviews · 4/4" && paneLabels.includes("1. one") && paneLabels.includes("4. four"));
	const writerHerdr = fakeHerdr();
	const writerBatch = await executeHerdrSubagents({ concurrency: 3, tasks: [{ name: "write-one", prompt: "write one" }, { name: "write-two", prompt: "write two" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: writerHerdr });
	check("write-capable batch is forced serial", writerBatch.details.effectiveConcurrency === 1 && writerHerdr.maxActive === 1 && writerHerdr.calls.filter(([name]) => name === "splitPane").length === 0);
	const focusedHerdr = fakeHerdr("focused");
	await executeHerdrSubagents({ tasks: [{ name: "inspect", prompt: "inspect", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: focusedHerdr });
	await new Promise((resolve) => setTimeout(resolve, 0));
	const focusedCalls = focusedHerdr.calls.map(([name]) => name);
	check("focused completed tab defers cleanup until focus leaves", focusedCalls.indexOf("waitForTabUnfocused") >= 0 && focusedCalls.indexOf("closeTab") > focusedCalls.indexOf("waitForTabUnfocused"));

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
	const backgroundId = "stable-background-id";
	const stableHerdr = fakeHerdr();
	const stable = await executeHerdrSubagents({ runId: backgroundId, tasks: [{ name: "stable", prompt: "stable", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: stableHerdr });
	check("preallocated background run id stays stable", stable.details.runId === backgroundId && readFileSync(join(stable.details.recordDirectory, "run.json"), "utf8").includes(backgroundId));

	const blockedHerdr = fakeHerdr("blocked");
	const blocked = await executeHerdrSubagents({ concurrency: 1, tasks: [{ name: "question", prompt: "inspect branch", agent: "explorer" }, { name: "after-answer", prompt: "continue queued", agent: "reviewer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: blockedHerdr });
	check("needs-input returns foreground control and preserves tab", blocked.details.status === "blocked" && blocked.details.tasks[0].question === "Which branch should I inspect?" && !blockedHerdr.calls.some(([name]) => name === "closeTab"));
	const resumed = await executeHerdrSubagents({ action: "respond", runId: blocked.details.runId, answer: "Inspect main." }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: blockedHerdr });
	const blockedRuns = blockedHerdr.calls.filter(([name]) => name === "runTask:start").map(([, request]) => request);
	check("answer resumes original pane and persistent Pi session", !resumed.isError && resumed.details.status === "completed" && blockedRuns.length === 3 && blockedRuns.every((request) => request.paneId === blockedRuns[0].paneId) && blockedRuns[1].args.includes("--session") && blockedRuns[1].args.includes(blocked.details.tasks[0].sessionFile));
	const resumedTasks = readdirSync(join(blocked.details.recordDirectory, "tasks")).sort().map((entry) => JSON.parse(readFileSync(join(blocked.details.recordDirectory, "tasks", entry, "task.json"), "utf8")));
	check("completion after answer continues queued siblings and settles original run", JSON.parse(readFileSync(join(blocked.details.recordDirectory, "run.json"), "utf8")).status === "completed" && resumedTasks.every((task) => task.status === "completed") && blockedHerdr.calls.at(-1)[0] === "closeTab");
	const twiceBlockedHerdr = fakeHerdr("blocked-twice");
	const twiceBlocked = await executeHerdrSubagents({ concurrency: 1, tasks: [{ name: "first-question", prompt: "first", agent: "explorer" }, { name: "second-question", prompt: "second", agent: "reviewer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: twiceBlockedHerdr });
	const secondQuestion = await executeHerdrSubagents({ action: "respond", runId: twiceBlocked.details.runId, answer: "main" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: twiceBlockedHerdr });
	check("queued sibling blocking returns its current question", secondQuestion.details.status === "blocked" && secondQuestion.details.question === "Which environment should I inspect?" && secondQuestion.content[0].text.includes("environment"));
	const failedAfterBlockHerdr = fakeHerdr("blocked");
	const failedAfterBlock = await executeHerdrSubagents({ concurrency: 1, tasks: [{ name: "question-first", prompt: "question", agent: "explorer" }, { name: "fails-later", prompt: "FAIL sibling", agent: "reviewer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: failedAfterBlockHerdr });
	const failedAnswer = await executeHerdrSubagents({ action: "respond", runId: failedAfterBlock.details.runId, answer: "main" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: failedAfterBlockHerdr });
	check("failed sibling after answer appears in compact result", failedAnswer.isError && failedAnswer.details.status === "partial" && failedAnswer.content[0].text.includes("fails-later") && failedAnswer.content[0].text.includes("failed"));

	const history = await listSubagentHistory(root);
	const stableHistory = history.find((run) => run.id === backgroundId);
	check("history lists compact project-local runs and tasks", Boolean(stableHistory?.tasks.length) && historyText(history).includes("stable") && !historyText(history).includes("FULL stable"));
	const historyHerdr = fakeHerdr();
	const historicalResume = await executeHerdrSubagents({ action: "resume", runId: backgroundId, task: 1, prompt: "follow up" }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: historyHerdr });
	const historyRunRequest = historyHerdr.calls.find(([name]) => name === "runTask:start")[1];
	check("historical resume opens a new tab with saved Pi session and effective config", !historicalResume.isError && historyHerdr.calls[0][0] === "createTab" && historyRunRequest.args.includes(stableHistory.tasks[0].sessionFile) && historyRunRequest.args.includes("fake/model") && historyRunRequest.args.includes(join(stableHistory.tasks[0].recordDirectory, "system-prompt.md")) && historyRunRequest.args.some((value) => String(value).includes("subagent_report")));
	const followupBlockedHerdr = fakeHerdr("blocked");
	const blockedFollowup = await executeHerdrSubagents({ action: "resume", runId: backgroundId, task: 1, prompt: "ask a follow-up" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: followupBlockedHerdr });
	const answeredFollowup = await executeHerdrSubagents({ action: "respond", runId: backgroundId, answer: "follow-up answer" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: followupBlockedHerdr });
	check("blocked historical follow-up remains publicly resumable", blockedFollowup.details.status === "blocked" && !answeredFollowup.isError && answeredFollowup.details.status === "completed");
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
	retryHerdr.createTab = async (request) => { createAttempts += 1; if (createAttempts < 3) throw new Error("transient startup failure"); return await createTab(request); };
	const retried = await executeHerdrSubagents({ tasks: [{ name: "retry", prompt: "retry", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: retryHerdr });
	check("startup failures retry at most twice before prompt", !retried.isError && createAttempts === 3 && retryHerdr.calls.filter(([name]) => name === "runTask:start").length === 1);
	const permanentStartupHerdr = fakeHerdr();
	let permanentAttempts = 0;
	permanentStartupHerdr.createTab = async () => { permanentAttempts += 1; throw new Error("permanent startup failure"); };
	const permanentStartup = await executeHerdrSubagents({ label: "permanent-startup", tasks: [{ name: "never-started", prompt: "never", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: permanentStartupHerdr });
	const permanentHistory = (await listSubagentHistory(root)).find((run) => run.label === "permanent-startup");
	check("exhausted startup failure persists failed run", permanentStartup.isError && permanentAttempts === 3 && permanentHistory?.status === "failed" && permanentHistory.tasks.every((task) => task.status === "failed"));
	const preflightHerdr = fakeHerdr();
	const originalPrepare = preflightHerdr.prepareTask.bind(preflightHerdr);
	let preflightAttempts = 0;
	preflightHerdr.prepareTask = async (args) => { preflightAttempts += 1; if (preflightAttempts < 3) throw new Error("child startup transient"); await originalPrepare(args); };
	const preflightRun = await executeHerdrSubagents({ tasks: [{ name: "preflight", prompt: "preflight", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: preflightHerdr });
	check("child startup preflight retries before one prompt submission", !preflightRun.isError && preflightAttempts === 3 && preflightHerdr.calls.filter(([name]) => name === "runTask:start").length === 1);
	const failedPreflightHerdr = fakeHerdr();
	let failedPreflightAttempts = 0;
	failedPreflightHerdr.prepareTask = async () => { failedPreflightAttempts += 1; throw new Error("permanent child preflight failure"); };
	const failedPreflightRun = await executeHerdrSubagents({ concurrency: 2, tasks: [{ name: "first", prompt: "first", agent: "explorer" }, { name: "second", prompt: "second", agent: "reviewer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: failedPreflightHerdr });
	check("failed FIFO preflight releases later start gate", failedPreflightRun.isError && failedPreflightAttempts === 6 && failedPreflightRun.details.tasks.every((task) => task.status === "failed"));
	const postFailureHerdr = fakeHerdr("post-fail");
	const postFailure = await executeHerdrSubagents({ tasks: [{ name: "no-retry", prompt: "side effect", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: postFailureHerdr });
	check("failure after prompt submission is preserved without rerun", postFailure.isError && postFailureHerdr.calls.filter(([name]) => name === "runTask:start").length === 1 && postFailure.details.tasks[0].error.includes("after prompt"));
	const stalledUpdates = [];
	const stalled = await executeHerdrSubagents({ tasks: [{ name: "long", prompt: "long", agent: "explorer" }] }, undefined, (update) => stalledUpdates.push(update.content[0].text), { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: fakeHerdr("stalled") });
	check("stalled warning does not kill child", !stalled.isError && stalledUpdates.some((text) => text.includes("appears stalled")));

	const atomicFile = join(root, "atomic.json");
	await Promise.all(Array.from({ length: 12 }, (_, index) => writeJsonAtomic(atomicFile, { index, payload: "x".repeat(1000) })));
	const atomicValue = JSON.parse(readFileSync(atomicFile, "utf8"));
	check("atomic snapshots remain parseable under replacement", Number.isInteger(atomicValue.index) && !readdirSync(root).some((entry) => entry.startsWith("atomic.json.tmp-")));
	await persistQueuedRun(root, "queued-persisted", { runId: "queued-persisted", background: true, tasks: [{ name: "later", prompt: "later", agent: "explorer" }] });
	check("queued background submission survives parent shutdown", (await loadQueuedRuns(root)).some((run) => run.runId === "queued-persisted"));

	const recoveryRoot = join(root, "recovery");
	const recoveryTask = join(recoveryRoot, ".pi", "herdr-subagents", "runs", "run", "tasks", "01-task");
	mkdirSync(recoveryTask, { recursive: true });
	writeFileSync(join(recoveryRoot, ".pi", "herdr-subagents", "runs", "run", "run.json"), JSON.stringify({ id: "recover", label: "recover", status: "running", startedAt: new Date().toISOString() }));
	writeFileSync(join(recoveryTask, "task.json"), JSON.stringify({ id: "task", runId: "recover", name: "lost", status: "running", paneId: "w1:missing", sessionFile: join(recoveryTask, "session.jsonl") }));
	const reconciliation = await reconcileSubagentRuns(recoveryRoot, fakeHerdr("missing-pane"));
	check("reconciliation marks missing child interrupted", reconciliation.interruptedTasks === 1 && JSON.parse(readFileSync(join(recoveryTask, "task.json"), "utf8")).status === "interrupted");
	const shellRecoveryTask = JSON.parse(readFileSync(join(recoveryTask, "task.json"), "utf8"));
	Object.assign(shellRecoveryTask, { status: "running" });
	writeFileSync(join(recoveryTask, "task.json"), JSON.stringify(shellRecoveryTask));
	writeFileSync(join(recoveryRoot, ".pi", "herdr-subagents", "runs", "run", "run.json"), JSON.stringify({ id: "recover", label: "recover", status: "running", startedAt: new Date().toISOString() }));
	const shellReconciliation = await reconcileSubagentRuns(recoveryRoot, fakeHerdr("shell-only"));
	check("pane with only a shell is not treated as live child", shellReconciliation.interruptedTasks === 1);
	const nodeProcessHerdr = join(root, "node-process-herdr");
	writeFileSync(nodeProcessHerdr, `#!/bin/sh\nprintf '%s\\n' '{"result":{"process_info":{"foreground_processes":[{"name":"node","argv":["/usr/bin/node","/opt/pi-coding-agent/dist/bundle/cli.js","--print"]}]}}}'\n`);
	chmodSync(nodeProcessHerdr, 0o700);
	check("node-hosted Pi process is treated as live", await new CliHerdrAutomation(nodeProcessHerdr).isTaskRunning("w1:p2"));
	const transientHerdr = join(root, "transient-herdr");
	writeFileSync(transientHerdr, `#!/bin/sh\necho 'temporary transport failure' >&2\nexit 1\n`);
	chmodSync(transientHerdr, 0o700);
	check("transient process query failure is conservatively live", await new CliHerdrAutomation(transientHerdr).isTaskRunning("w1:p2"));

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
	check("reconciliation preserves unstarted tasks as queued", JSON.parse(readFileSync(join(queuedRunDirectory, "run.json"), "utf8")).status === "queued");
	await continueQueuedRun(queuedRunDirectory, queuedRecoveryHerdr);
	check("startup continuation restores bounded concurrency", queuedRecoveryHerdr.maxActive === 2 && JSON.parse(readFileSync(join(secondRecoveryTask, "task.json"), "utf8")).status === "completed" && JSON.parse(readFileSync(join(thirdRecoveryTask, "task.json"), "utf8")).status === "completed" && JSON.parse(readFileSync(join(queuedRunDirectory, "run.json"), "utf8")).status === "completed");
} finally {
	restoreEnv();
	rmSync(root, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

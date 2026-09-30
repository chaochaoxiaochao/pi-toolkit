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
import { cancelQueuedRuns, loadQueuedRuns, persistQueuedRun } from "../src/queued-runs.ts";
import { cancelActiveSubagentRuns, reconcileSubagentRuns } from "../src/reconcile.ts";
import { continueQueuedRun } from "../src/continue-run.ts";
import { CliHerdrAutomation } from "../src/herdr.ts";
import { fleetEditorHasFocus, FleetSelection, fleetLines } from "../src/fleet.ts";
import { validateToolParams } from "../src/validation.ts";

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
	check("flat mode validation accepts supported calls", [
		{ action: "list" }, { action: "history" }, { action: "cleanup", runId: "run" },
		{ action: "respond", runId: "run", answer: "yes", task: 1 },
		{ action: "resume", runId: "run", task: 1, prompt: "continue" },
		{ prompt: "one task", agent: "worker", label: "one", model: "fake/model" },
		{ tasks: [{ name: "one", prompt: "do it" }], concurrency: 2, background: true },
	].every((params) => validateToolParams(params) === undefined));
	check("flat mode validation rejects ambiguous and extraneous fields", [
		validateToolParams({ prompt: "one", tasks: [{ name: "two", prompt: "two" }] }),
		validateToolParams({ action: "list", prompt: "not allowed" }),
		validateToolParams({ action: "respond", runId: "run" }),
		validateToolParams({ tasks: [{ name: "one", prompt: "one" }], agent: "worker" }),
		validateToolParams({ prompt: "one", runId: "run" }),
		validateToolParams({ prompt: "one", task: 1 }),
		validateToolParams({ tasks: [{ name: "one", prompt: "one" }], answer: "extra" }),
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
	check("Fleet ignores unknown focus, dialogs, and overlays", fleetEditorHasFocus(undefined, () => false) === false && fleetEditorHasFocus({ kind: "dialog" }, () => false) === false && fleetEditorHasFocus({ kind: "editor" }, () => true) === true);

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
	const batchPrompts = batchHerdr.calls.filter(([name]) => name === "promptAgent").map(([, request]) => request.prompt);
	const batchStarts = batchHerdr.calls.filter(([name]) => name === "startAgent").map(([, request]) => request);
	check("read-only batch uses bounded concurrency", batchDetails.effectiveConcurrency === 2 && batchHerdr.maxActive === 2 && batchHerdr.calls.filter(([name]) => name === "splitPane").length === 3);
	check("batch is FIFO with a dedicated pane per task", batchPrompts.join(",") === "one slow,two,three FAIL,four" && new Set(batchStarts.map((request) => request.paneId)).size === 4);
	check("failed sibling does not cancel batch", batch.isError && batchDetails.status === "partial" && batchDetails.tasks.map((task) => task.name).join(",") === "one,two,three,four" && batchDetails.tasks[2].status === "failed" && batchDetails.tasks[3].status === "completed");
	const batchCleanupHerdr = fakeHerdr("close-failed");
	const batchCleanup = await executeHerdrSubagents({ tasks: [{ name: "cleanup", prompt: "cleanup", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: batchCleanupHerdr });
	const batchCleanupRecord = JSON.parse(readFileSync(join(batchCleanup.details.recordDirectory, "run.json"), "utf8"));
	check("batch cleanup failure is persisted and surfaced", batchCleanup.isError && batchCleanup.content[0].text.includes("cleanup failed") && batchCleanupRecord.status === "failed" && batchCleanupRecord.cleanupError.includes("tab still busy"));
	const activeUpdate = batchUpdates.find((update) => update.activity?.some((task) => task.status === "running"));
	const counts = activityCounts(activeUpdate);
	const focusHerdr = fakeHerdr();
	const runningTask = activeUpdate.activity.find((task) => task.status === "running");
	const focused = await focusActiveTask(activeUpdate, runningTask.index + 1, focusHerdr);
	check("active progress exposes widget counts and exact pane navigation", counts.running > 0 && counts.queued > 0 && focused && focusHerdr.calls.at(-1)[0] === "focusPane" && focusHerdr.calls.at(-1)[1].paneId === runningTask.paneId);
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
	const deferredFailureHerdr = fakeHerdr();
	deferredFailureHerdr.isTabFocused = async () => true;
	deferredFailureHerdr.closeTab = async () => { throw new Error("deferred close failed"); };
	const deferredFailure = await executeHerdrSubagents({ tasks: [{ name: "deferred-cleanup", prompt: "inspect", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: deferredFailureHerdr });
	await new Promise((resolve) => setTimeout(resolve, 10));
	const deferredFailureRecord = JSON.parse(readFileSync(join(deferredFailure.details.recordDirectory, "run.json"), "utf8"));
	check("deferred focus cleanup failure is persisted", deferredFailureRecord.cleanupError === "deferred close failed");
	const cancelledHerdr = fakeHerdr();
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
	check("parent shutdown cancels active work and closes its tab", cancelledBatch.details.status === "cancelled" && cancelledTaskRecord.status === "cancelled" && cancelledHerdr.calls.at(-1)[0] === "closeTab");
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
	const backgroundId = "stable-background-id";
	const stableHerdr = fakeHerdr();
	const stable = await executeHerdrSubagents({ tasks: [{ name: "stable", prompt: "stable", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: stableHerdr, runId: backgroundId });
	check("preallocated background run id stays stable", stable.details.runId === backgroundId && readFileSync(join(stable.details.recordDirectory, "run.json"), "utf8").includes(backgroundId));

	const blockedHerdr = fakeHerdr("blocked");
	const blocked = await executeHerdrSubagents({ concurrency: 1, tasks: [{ name: "question", prompt: "inspect branch", agent: "explorer" }, { name: "after-answer", prompt: "continue queued", agent: "reviewer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: blockedHerdr });
	check("needs-input returns foreground control and preserves tab", blocked.details.status === "blocked" && blocked.details.tasks[0].question === "Which branch should I inspect?" && !blockedHerdr.calls.some(([name]) => name === "closeTab"));
	const activeCleanup = await executeHerdrSubagents({ action: "cleanup", runId: blocked.details.runId }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: blockedHerdr });
	check("cleanup refuses to delete an active blocked run", activeCleanup.isError && activeCleanup.content[0].text.includes("still active") && existsSync(blocked.details.recordDirectory));
	const resumed = await executeHerdrSubagents({ action: "respond", runId: blocked.details.runId, answer: "Inspect main." }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: blockedHerdr });
	const blockedStarts = blockedHerdr.calls.filter(([name]) => name === "startAgent").map(([, request]) => request);
	const blockedPrompts = blockedHerdr.calls.filter(([name]) => name === "promptAgent").map(([, request]) => request);
	check("answer resumes original live Agent and queued sibling gets a new pane", !resumed.isError && resumed.details.status === "completed" && blockedPrompts.length === 3 && blockedPrompts[1].target === blockedPrompts[0].target && blockedStarts.length === 2 && new Set(blockedStarts.map((request) => request.paneId)).size === 2);
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
	const responseFailureHerdr = fakeHerdr("blocked-then-post-fail");
	const responseFailureRun = await executeHerdrSubagents({ tasks: [{ name: "response-fails", prompt: "question", agent: "explorer" }] }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: responseFailureHerdr });
	const responseFailure = await executeHerdrSubagents({ action: "respond", runId: responseFailureRun.details.runId, answer: "main" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: responseFailureHerdr });
	const responseFailureTask = JSON.parse(readFileSync(join(responseFailureRun.details.recordDirectory, "tasks", readdirSync(join(responseFailureRun.details.recordDirectory, "tasks"))[0], "task.json"), "utf8"));
	check("failed blocked response settles durable task instead of leaving running", responseFailure.isError && responseFailure.details.status === "failed" && responseFailureTask.status === "failed" && responseFailureHerdr.calls.at(-1)[0] === "closeTab");
	const siblingFailureHerdr = fakeHerdr("blocked-then-post-fail");
	const siblingFailureRun = await executeHerdrSubagents({ concurrency: 1, tasks: [{ name: "response-fails", prompt: "question", agent: "explorer" }, { name: "queued-sibling", prompt: "later", agent: "reviewer" }] }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: siblingFailureHerdr });
	await executeHerdrSubagents({ action: "respond", runId: siblingFailureRun.details.runId, answer: "main" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: siblingFailureHerdr });
	const siblingFailureTasks = readdirSync(join(siblingFailureRun.details.recordDirectory, "tasks")).map((entry) => JSON.parse(readFileSync(join(siblingFailureRun.details.recordDirectory, "tasks", entry, "task.json"), "utf8")));
	check("failed blocked response settles every sibling", siblingFailureTasks.every((task) => ["failed", "cancelled", "completed"].includes(task.status)) && siblingFailureTasks.some((task) => task.status === "cancelled"));
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
	check("aborted queued continuation is persisted as cancelled", cancelledContinuationTask.status === "cancelled" && cancelledContinuationRun.status === "cancelled");
	const deadPaneHerdr = fakeHerdr("blocked");
	const deadPaneRun = await executeHerdrSubagents({ tasks: [{ name: "dead-pane", prompt: "question", agent: "explorer" }] }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: deadPaneHerdr });
	deadPaneHerdr.paneExists = async () => false;
	const deadPaneResume = await executeHerdrSubagents({ action: "respond", runId: deadPaneRun.details.runId, answer: "main" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: deadPaneHerdr });
	const deadPaneTaskDirectory = join(deadPaneRun.details.recordDirectory, "tasks", readdirSync(join(deadPaneRun.details.recordDirectory, "tasks"))[0]);
	const deadPaneTask = JSON.parse(readFileSync(join(deadPaneTaskDirectory, "task.json"), "utf8"));
	check("dead blocked pane falls back to a new tab", !deadPaneResume.isError && deadPaneHerdr.calls.filter(([name]) => name === "createTab").length === 2 && deadPaneTask.tabId === "w1:t2");

	const history = await listSubagentHistory(root);
	const stableHistory = history.find((run) => run.id === backgroundId);
	check("history lists compact project-local runs and tasks", Boolean(stableHistory?.tasks.length) && historyText(history).includes("stable") && !historyText(history).includes("FULL stable"));
	const historyHerdr = fakeHerdr();
	const historicalResume = await executeHerdrSubagents({ action: "resume", runId: backgroundId, task: 1, prompt: "follow up" }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: historyHerdr });
	const historyStartRequest = historyHerdr.calls.find(([name]) => name === "startAgent")[1];
	check("historical resume opens a new interactive Agent with the saved Pi session", !historicalResume.isError && historyHerdr.calls[0][0] === "createTab" && historyStartRequest.args.includes(stableHistory.tasks[0].sessionFile) && historyStartRequest.args.includes("fake/model") && historyStartRequest.args.some((value) => String(value).includes("subagent_report")) && existsSync(join(stableHistory.tasks[0].recordDirectory, "turns", "02.json")));
	const historicalTaskRecord = JSON.parse(readFileSync(join(stableHistory.tasks[0].recordDirectory, "task.json"), "utf8"));
	const historicalTurnRecord = JSON.parse(readFileSync(join(stableHistory.tasks[0].recordDirectory, "turns", "02.json"), "utf8"));
	check("historical task and turn retain their tab identity", historicalTaskRecord.tabId === historicalResume.details.tabId && historicalTurnRecord.tabId === historicalResume.details.tabId);
	const partialResumeHerdr = fakeHerdr();
	await executeHerdrSubagents({ action: "resume", runId: failedAfterBlock.details.runId, task: 1, prompt: "follow up completed task" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: partialResumeHerdr });
	const partialResumeRun = JSON.parse(readFileSync(join(failedAfterBlock.details.recordDirectory, "run.json"), "utf8"));
	check("historical follow-up preserves partial batch aggregation", partialResumeRun.status === "partial");
	const followupBlockedHerdr = fakeHerdr("blocked");
	const blockedFollowup = await executeHerdrSubagents({ action: "resume", runId: backgroundId, task: 1, prompt: "ask a follow-up" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: followupBlockedHerdr });
	const answeredFollowup = await executeHerdrSubagents({ action: "respond", runId: backgroundId, answer: "follow-up answer" }, undefined, undefined, { cwd: root }, { agentsDirectory: join(process.cwd(), "agents"), herdr: followupBlockedHerdr });
	const historicalTurns = join(stableHistory.tasks[0].recordDirectory, "turns");
	const answeredTurn = JSON.parse(readFileSync(join(historicalTurns, "03.json"), "utf8"));
	check("blocked historical follow-up remains publicly resumable with durable turns", blockedFollowup.details.status === "blocked" && !answeredFollowup.isError && answeredFollowup.details.status === "completed" && existsSync(join(historicalTurns, "01.json")) && answeredTurn.status === "completed" && answeredTurn.events.some((event) => event.type === "answer"));
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
	retryHerdr.createTab = async (request) => { createAttempts += 1; if (createAttempts < 3) throw new Error("transient startup failure"); return await createTab(request); };
	const retried = await executeHerdrSubagents({ tasks: [{ name: "retry", prompt: "retry", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: retryHerdr });
	check("tab startup failures retry at most twice before prompt", !retried.isError && createAttempts === 3 && retryHerdr.calls.filter(([name]) => name === "promptAgent").length === 1);
	const permanentStartupHerdr = fakeHerdr();
	let permanentAttempts = 0;
	permanentStartupHerdr.createTab = async () => { permanentAttempts += 1; throw new Error("permanent startup failure"); };
	const permanentStartup = await executeHerdrSubagents({ label: "permanent-startup", tasks: [{ name: "never-started", prompt: "never", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: permanentStartupHerdr });
	const permanentHistory = (await listSubagentHistory(root)).find((run) => run.label === "permanent-startup");
	check("exhausted startup failure persists failed run", permanentStartup.isError && permanentAttempts === 3 && permanentHistory?.status === "failed" && permanentHistory.tasks.every((task) => task.status === "failed"));
	const startRetryHerdr = fakeHerdr();
	const originalStart = startRetryHerdr.startAgent.bind(startRetryHerdr);
	let startAttempts = 0;
	startRetryHerdr.startAgent = async (request) => { startAttempts += 1; if (startAttempts < 3) throw new Error("child startup transient"); await originalStart(request); };
	const startRetryRun = await executeHerdrSubagents({ tasks: [{ name: "start-retry", prompt: "start retry", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: startRetryHerdr });
	check("Agent startup retries before one prompt submission", !startRetryRun.isError && startAttempts === 3 && startRetryHerdr.calls.filter(([name]) => name === "promptAgent").length === 1);
	const failedStartHerdr = fakeHerdr();
	let failedStartAttempts = 0;
	failedStartHerdr.startAgent = async () => { failedStartAttempts += 1; throw new Error("permanent child startup failure"); };
	const failedStartRun = await executeHerdrSubagents({ concurrency: 2, tasks: [{ name: "first", prompt: "first", agent: "explorer" }, { name: "second", prompt: "second", agent: "reviewer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: failedStartHerdr });
	check("failed Agent startup releases other workers", failedStartRun.isError && failedStartAttempts === 6 && failedStartRun.details.tasks.every((task) => task.status === "failed"));
	const postFailureHerdr = fakeHerdr("post-fail");
	const postFailure = await executeHerdrSubagents({ tasks: [{ name: "no-retry", prompt: "side effect", agent: "explorer" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: postFailureHerdr });
	check("failure after prompt submission is preserved without rerun", postFailure.isError && postFailureHerdr.calls.filter(([name]) => name === "promptAgent").length === 1 && postFailure.details.tasks[0].error.includes("after prompt"));
	check("production batch path never passes print mode", batchStarts.every((request) => !request.args.includes("--print")));

	const atomicFile = join(root, "atomic.json");
	await Promise.all(Array.from({ length: 12 }, (_, index) => writeJsonAtomic(atomicFile, { index, payload: "x".repeat(1000) })));
	const atomicValue = JSON.parse(readFileSync(atomicFile, "utf8"));
	check("atomic snapshots remain parseable under replacement", Number.isInteger(atomicValue.index) && !readdirSync(root).some((entry) => entry.startsWith("atomic.json.tmp-")));
	await persistQueuedRun(root, "queued-persisted", { runId: "queued-persisted", background: true, tasks: [{ name: "later", prompt: "later", agent: "explorer" }] });
	check("queued background submission survives parent shutdown", (await loadQueuedRuns(root)).some((run) => run.runId === "queued-persisted"));
	await cancelQueuedRuns(root, ["queued-persisted"]);
	const cancelledQueued = (await listSubagentHistory(root)).find((run) => run.id === "queued-persisted");
	check("parent shutdown archives queued work as cancelled", !(await loadQueuedRuns(root)).some((run) => run.runId === "queued-persisted") && cancelledQueued?.status === "cancelled" && cancelledQueued.tasks[0].status === "cancelled");
	await persistQueuedRun(root, "live-foreign-queue", { background: true, tasks: [{ name: "foreign", prompt: "foreign" }] }, "foreign-owner", process.pid);
	await cancelQueuedRuns(root, ["live-foreign-queue"], "orphan cleanup", undefined, true);
	check("startup leaves another live parent process queue untouched", (await loadQueuedRuns(root)).some((run) => run.runId === "live-foreign-queue"));
	const ownershipRoot = join(root, "ownership");
	for (const [suffix, owner] of [["a", "owner-a"], ["b", "owner-b"]]) {
		const directory = join(ownershipRoot, ".pi", "herdr-subagents", "runs", suffix);
		const taskDirectory = join(directory, "tasks", "01-task");
		mkdirSync(taskDirectory, { recursive: true });
		writeFileSync(join(directory, "run.json"), JSON.stringify({ id: `run-${suffix}`, label: suffix, status: "blocked", cwd: ownershipRoot, ownerSessionId: owner, ownerProcessId: process.pid, tabId: `w1:t${suffix}`, taskIds: [`task-${suffix}`] }));
		writeFileSync(join(taskDirectory, "task.json"), JSON.stringify({ id: `task-${suffix}`, runId: `run-${suffix}`, order: 1, name: suffix, status: "blocked", sessionFile: join(taskDirectory, "session.jsonl") }));
	}
	const ownershipHerdr = fakeHerdr();
	await cancelActiveSubagentRuns(ownershipRoot, ownershipHerdr, "shutdown", "owner-a");
	check("graceful shutdown cancels only runs owned by that parent session", JSON.parse(readFileSync(join(ownershipRoot, ".pi", "herdr-subagents", "runs", "a", "run.json"), "utf8")).status === "cancelled" && JSON.parse(readFileSync(join(ownershipRoot, ".pi", "herdr-subagents", "runs", "b", "run.json"), "utf8")).status === "blocked");
	await reconcileSubagentRuns(ownershipRoot, ownershipHerdr, "new-owner", process.pid + 1);
	check("startup reconciliation leaves another live parent process untouched", JSON.parse(readFileSync(join(ownershipRoot, ".pi", "herdr-subagents", "runs", "b", "run.json"), "utf8")).status === "blocked");

	const recoveryRoot = join(root, "recovery");
	const recoveryTask = join(recoveryRoot, ".pi", "herdr-subagents", "runs", "run", "tasks", "01-task");
	mkdirSync(recoveryTask, { recursive: true });
	writeFileSync(join(recoveryRoot, ".pi", "herdr-subagents", "runs", "run", "run.json"), JSON.stringify({ id: "recover", label: "recover", status: "running", startedAt: new Date().toISOString() }));
	writeFileSync(join(recoveryTask, "task.json"), JSON.stringify({ id: "task", runId: "recover", name: "lost", status: "running", paneId: "w1:missing", sessionFile: join(recoveryTask, "session.jsonl") }));
	const reconciliation = await reconcileSubagentRuns(recoveryRoot, fakeHerdr("missing-pane"), "new-owner");
	check("reconciliation marks stale child cancelled", reconciliation.cancelledTasks === 1 && JSON.parse(readFileSync(join(recoveryTask, "task.json"), "utf8")).status === "cancelled");
	const shellRecoveryTask = JSON.parse(readFileSync(join(recoveryTask, "task.json"), "utf8"));
	Object.assign(shellRecoveryTask, { status: "running" });
	writeFileSync(join(recoveryTask, "task.json"), JSON.stringify(shellRecoveryTask));
	writeFileSync(join(recoveryRoot, ".pi", "herdr-subagents", "runs", "run", "run.json"), JSON.stringify({ id: "recover", label: "recover", status: "running", startedAt: new Date().toISOString() }));
	const shellReconciliation = await reconcileSubagentRuns(recoveryRoot, fakeHerdr("shell-only"), "new-owner");
	check("pane with only a shell is not treated as live child", shellReconciliation.interruptedTasks === 1);
	const nodeProcessHerdr = join(root, "node-process-herdr");
	writeFileSync(nodeProcessHerdr, `#!/bin/sh\nprintf '%s\\n' '{"result":{"process_info":{"foreground_processes":[{"name":"node","argv":["/usr/bin/node","/opt/pi-coding-agent/dist/bundle/cli.js"]}]}}}'\n`);
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
	check("reconciliation preserves unstarted task records as queued", JSON.parse(readFileSync(join(secondRecoveryTask, "task.json"), "utf8")).status === "queued" && JSON.parse(readFileSync(join(thirdRecoveryTask, "task.json"), "utf8")).status === "queued");
	await continueQueuedRun(queuedRunDirectory, queuedRecoveryHerdr);
	check("startup continuation restores bounded concurrency", queuedRecoveryHerdr.maxActive === 2 && JSON.parse(readFileSync(join(secondRecoveryTask, "task.json"), "utf8")).status === "completed" && JSON.parse(readFileSync(join(thirdRecoveryTask, "task.json"), "utf8")).status === "completed" && JSON.parse(readFileSync(join(queuedRunDirectory, "run.json"), "utf8")).status === "completed");

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

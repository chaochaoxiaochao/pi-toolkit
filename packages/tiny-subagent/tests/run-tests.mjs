import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverPackageAgents, parseAgentMarkdown } from "../src/personas.ts";
import { loadSubagentConfiguration } from "../src/config.ts";
import { runTinySubagent } from "../src/runner.ts";
import { executeTinySubagent } from "../src/tool.ts";

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

const root = mkdtempSync(join(tmpdir(), "pi-tiny-subagent-test-"));
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
	return {
		calls,
		get maxActive() { return maxActive; },
		async createTab(request) {
			calls.push(["createTab", request]);
			taskDirectory = request.env.PI_TINY_SUBAGENT_TASK_DIR;
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
		async runTask(request) {
			calls.push(["runTask:start", request]);
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, request.prompt.includes("slow") ? 15 : 2));
			const directory = request.env.PI_TINY_SUBAGENT_TASK_DIR;
			writeFileSync(join(directory, "session.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: request.marker, cwd: root })}\n`);
			const failed = request.prompt.includes("FAIL");
			writeFileSync(join(directory, "result.md"), `FULL ${request.prompt}`);
			writeFileSync(join(directory, "report.json"), JSON.stringify({ status: failed ? "failed" : "completed", summary: failed ? `${request.prompt} failed.` : `${request.prompt} completed.`, ...(failed ? { error: "expected failure" } : {}), documents: [] }));
			active -= 1;
			calls.push(["runTask:end", request]);
		},
		async renamePane(paneId, label) { calls.push(["renamePane", { paneId, label }]); },
		async renameTab(tabId, label) { calls.push(["renameTab", { tabId, label }]); },
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
	setEnv({ HERDR_ENV: "0", PI_TINY_SUBAGENT_PI_BINARY: "/definitely/missing/pi" });
	const unavailableHerdr = fakeHerdr();
	const outside = await runTinySubagent("hello", { cwd: root, herdr: unavailableHerdr });
	check("Herdr is required", !outside.ok && outside.errorMessage?.includes("inside Herdr") && unavailableHerdr.calls.length === 0);

	setEnv({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", PI_TINY_SUBAGENT_PI_BINARY: "/definitely/missing/pi" });
	const herdr = fakeHerdr();
	const success = await runTinySubagent("Review authentication", {
		cwd: root,
		label: "auth-review",
		agent: "worker",
		model: "fake/model",
		tools: ["read", "grep"],
		systemPrompt: "You are a focused worker.",
		herdr,
	});
	check("compact successful report", success.ok && success.status === "completed" && success.summary === "Authentication review completed." && success.documents.length === 1 && !success.output.includes("FULL RESULT"));
	check("Herdr lifecycle", herdr.calls.map(([name]) => name).join(",") === "createTab,startAgent,promptAgent,closeTab");
	const createRequest = herdr.calls[0][1];
	const startRequest = herdr.calls[1][1];
	check("named unfocused tab in parent workspace", createRequest.workspaceId === "w1" && createRequest.cwd === root && createRequest.label === "SA · auth-review" && createRequest.focus === false);
	check("child environment points at durable task", createRequest.env.PI_SUBAGENT_CHILD === "1" && createRequest.env.PI_TINY_SUBAGENT_TASK_DIR.includes(join(".pi", "herdr-subagents", "runs")));
	check("persistent isolated child Pi", startRequest.kind === "pi" && startRequest.paneId === "w1:p2" && startRequest.args.includes("--session") && startRequest.args.includes("--no-extensions") && startRequest.args.includes("--extension") && startRequest.args.includes("--no-skills") && startRequest.args.includes("--model") && startRequest.args.includes("fake/model") && startRequest.args.includes("--tools") && startRequest.args.includes("read,grep,subagent_report"));
	check("prompt submitted through Herdr", herdr.calls[2][1].prompt === "Review authentication" && herdr.calls[2][1].target === startRequest.name);

	const runDirectory = latestRunDirectory();
	const runRecord = JSON.parse(readFileSync(join(runDirectory, "run.json"), "utf8"));
	const taskDirectory = join(runDirectory, "tasks", readdirSync(join(runDirectory, "tasks"))[0]);
	const taskRecord = JSON.parse(readFileSync(join(taskDirectory, "task.json"), "utf8"));
	check("run and task records settle", runRecord.status === "completed" && taskRecord.status === "completed" && taskRecord.prompt === "Review authentication" && taskRecord.model === "fake/model");
	check("full result and session stay on disk", readFileSync(join(taskDirectory, "result.md"), "utf8").startsWith("FULL RESULT") && existsSync(join(taskDirectory, "session.jsonl")));

	const extensionHerdr = fakeHerdr();
	const publicResult = await executeTinySubagent({ agent: "worker", prompt: "Review through the public tool" }, undefined, undefined, {
		cwd: root,
		model: { provider: "fake", id: "model" },
		thinkingLevel: "medium",
	}, { agentsDirectory: join(process.cwd(), "agents"), herdr: extensionHerdr });
	check("public extension behavior uses injectable Herdr", !publicResult.isError && publicResult.content[0].text.includes("Authentication review completed.") && !publicResult.content[0].text.includes("FULL RESULT") && extensionHerdr.calls.map(([name]) => name).join(",") === "createTab,startAgent,promptAgent,closeTab", JSON.stringify({ publicResult, calls: extensionHerdr.calls.map(([name]) => name) }));

	const failedHerdr = fakeHerdr("failed");
	const failedRun = await runTinySubagent("Fail cleanly", { cwd: root, herdr: failedHerdr });
	check("structured child failure", !failedRun.ok && failedRun.status === "failed" && failedRun.summary === "Authentication review failed." && failedRun.errorMessage === "provider unavailable" && failedHerdr.calls.at(-1)[0] === "closeTab");

	const silentHerdr = fakeHerdr("silent");
	const silent = await runTinySubagent("Forget report", { cwd: root, herdr: silentHerdr });
	check("missing report is visible failure", !silent.ok && silent.errorMessage?.includes("did not submit") && silentHerdr.calls.at(-1)[0] === "closeTab");

	const cleanupHerdr = fakeHerdr("close-failed");
	const cleanupFailure = await runTinySubagent("Complete then fail cleanup", { cwd: root, herdr: cleanupHerdr });
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
	const configuredHerdr = fakeHerdr();
	const configuredRun = await executeTinySubagent({ agent: "worker", model: "task/model", prompt: "Use configured values" }, undefined, undefined, { cwd: configRoot, model: { provider: "parent", id: "model" }, thinkingLevel: "medium" }, { agentsDirectory: packageAgents, configurationPaths, herdr: configuredHerdr });
	const configuredStart = configuredHerdr.calls.find(([name]) => name === "startAgent")[1];
	check("configured persona uses displayed effective values", !configuredRun.isError && configuredStart.args.includes("task/model") && configuredStart.args.includes("high") && configuredStart.args.includes("--skill") && configuredStart.args.includes("project-skill"));

	const batchHerdr = fakeHerdr();
	const batch = await executeTinySubagent({ label: "reviews", concurrency: 2, tasks: [
		{ name: "one", prompt: "one slow", agent: "explorer" },
		{ name: "two", prompt: "two", agent: "reviewer" },
		{ name: "three", prompt: "three FAIL", agent: "explorer" },
		{ name: "four", prompt: "four", agent: "reviewer" },
	] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: batchHerdr });
	const batchDetails = batch.details;
	const batchRuns = batchHerdr.calls.filter(([name]) => name === "runTask:start").map(([, request]) => request);
	check("read-only batch uses bounded concurrency", batchDetails.effectiveConcurrency === 2 && batchHerdr.maxActive === 2 && batchHerdr.calls.filter(([name]) => name === "splitPane").length === 1);
	check("batch is FIFO and reuses bounded panes", batchRuns.map((request) => request.prompt).join(",") === "one slow,two,three FAIL,four" && new Set(batchRuns.map((request) => request.paneId)).size === 2);
	check("failed sibling does not cancel batch", batch.isError && batchDetails.status === "partial" && batchDetails.tasks.map((task) => task.name).join(",") === "one,two,three,four" && batchDetails.tasks[2].status === "failed" && batchDetails.tasks[3].status === "completed");
	const writerHerdr = fakeHerdr();
	const writerBatch = await executeTinySubagent({ concurrency: 3, tasks: [{ name: "write-one", prompt: "write one" }, { name: "write-two", prompt: "write two" }] }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } }, { agentsDirectory: join(process.cwd(), "agents"), herdr: writerHerdr });
	check("write-capable batch is forced serial", writerBatch.details.effectiveConcurrency === 1 && writerHerdr.maxActive === 1 && writerHerdr.calls.filter(([name]) => name === "splitPane").length === 0);
} finally {
	restoreEnv();
	rmSync(root, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

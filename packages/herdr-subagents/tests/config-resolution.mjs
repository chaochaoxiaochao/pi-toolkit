import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSubagentConfiguration } from "../src/config.ts";
import { discoverPackageAgents, parseAgentMarkdown } from "../src/personas.ts";
import { executeHerdrSubagents } from "../src/tool.ts";
import { listSubagentHistory } from "../src/history.ts";
import { batchFixture, readTask, writeJson } from "./fixtures/herdr.mjs";

const f = batchFixture(({ directory, publish }) => {
	pending.push(directory);
	if (pending.length === 2) for (const path of pending) publish(path);
	return { status: "idle" };
});
const pending = [];
const paths = {
	globalConfig: join(f.root, "global.json"), projectConfig: join(f.root, "project.json"),
	globalAgents: join(f.root, "global-agents"), projectAgents: join(f.root, "project-agents"),
};
const agents = join(f.root, "package-agents");
for (const directory of [agents, paths.globalAgents, paths.projectAgents]) mkdirSync(directory);
const markdown = (name, fields, body) => `---\nname: ${name}\ndescription: ${body}\n${fields}---\n${body}`;
const load = (parent = "parent/model") => loadSubagentConfiguration(f.root, agents, parent, paths);
const persona = (name = "worker") => load().personas.find((item) => item.name === name);
try {
	writeFileSync(join(agents, "worker.md"), markdown("worker", "access: write\nmodel: package/model\n", "Package body"));
	writeFileSync(join(agents, "reader.md"), markdown("reader", "access: read\nthinking: minimal\ntools: read, bash\n", "Read only"));
	assert.equal(persona().source, "package");
	writeFileSync(join(paths.globalAgents, "worker.md"), markdown("worker", "access: read\nmodel: global/markdown\n", "Global body"));
	assert.deepEqual([persona().source, persona().systemPrompt, persona().access, persona().model], ["global", "Global body", "read", "global/markdown"]);
	writeFileSync(join(paths.projectAgents, "worker.md"), markdown("worker", "", "Project body"));
	assert.deepEqual([persona().source, persona().systemPrompt, persona().access, persona().model], ["project", "Project body", "write", "parent/model"], "definitions replace the whole lower-priority Persona");
	writeJson(paths.globalConfig, { defaultConcurrency: 2, maxConcurrency: 8, defaultModel: "global/default", defaultThinking: "medium", personas: { worker: { model: "global/worker", thinking: "low", skills: ["global-skill"], extensions: ["./global.ts"] } } });
	writeJson(paths.projectConfig, { maxConcurrency: 3, defaultThinking: "high", personas: { worker: { model: "project/worker", skills: ["project-skill"] } } });
	let configuration = load();
	assert.deepEqual([configuration.settings.defaultConcurrency, configuration.settings.maxConcurrency, configuration.settings.defaultThinking], [2, 3, "high"]);
	assert.deepEqual([configuration.settingSources.defaultConcurrency, configuration.settingSources.maxConcurrency], ["global", "project"]);
	assert.deepEqual([persona().model, persona().modelSource, persona().thinking, persona().thinkingSource, persona().skills, persona().skillsSource], ["project/worker", "project persona", "low", "global persona", ["project-skill"], "project persona"]);
	assert.equal(persona("reader").thinking, "minimal", "Markdown thinking outranks defaults");
	for (const [field, invalid, valid] of [
		["model", 42, "global/worker"], ["thinking", " ", "low"], ["skills", [false], ["global-skill"]], ["extensions", [""], ["./global.ts"]],
	]) {
		writeJson(paths.projectConfig, { personas: { worker: { [field]: invalid } } });
		configuration = load();
		assert.deepEqual(configuration.personas.find((item) => item.name === "worker")[field], valid);
		assert.ok(configuration.diagnostics.some((line) => line.startsWith(`project persona 'worker' ${field} must`)));
	}
	writeJson(paths.projectConfig, { defaultConcurrency: 9, maxConcurrency: 3, defaultThinking: "", defaultModel: false });
	configuration = load();
	assert.equal(configuration.settings.defaultConcurrency, 3);
	assert.equal(configuration.settings.defaultThinking, "medium");
	assert.equal(configuration.settings.defaultModel, "global/default");
	for (const field of ["defaultThinking", "defaultModel"]) assert.ok(configuration.diagnostics.some((line) => line.includes(`project ${field} must`)));
	assert.ok(configuration.diagnostics.includes("defaultConcurrency exceeds maxConcurrency; maxConcurrency is used"));
	for (const [name, content] of [["broken", "missing frontmatter"], ["invalid-tools", markdown("bad", "tools: unknown\n", "bad")]]) writeFileSync(join(agents, `${name}.md`), content);
	const discovery = discoverPackageAgents(agents);
	assert.equal(discovery.diagnostics.length, 2);
	assert.equal(parseAgentMarkdown(markdown("quoted", 'extensions: "./provider with spaces.ts", npm:provider@1\n', "body")).extensions[0], "./provider with spaces.ts");
	console.log("PASS full Persona replacement, layered fields, diagnostics and Markdown precedence");

	writeJson(paths.projectConfig, { defaultConcurrency: 2, personas: { reader: { thinking: "high", skills: ["one-skill"], extensions: ["./provider with spaces.ts"] } } });
	const old = process.env.HERDR_ENV;
	process.env.HERDR_ENV = "1";
	const workspace = process.env.HERDR_WORKSPACE_ID;
	process.env.HERDR_WORKSPACE_ID = "fixture-workspace";
	try {
		const response = await executeHerdrSubagents({ label: "configuration", concurrency: 2, tasks: [
			{ name: "one", prompt: "one", agent: "reader", model: "model/one" },
			{ name: "two", prompt: "two", agent: "reader", model: "model/two" },
		] }, undefined, undefined, { cwd: f.root }, { agentsDirectory: agents, configurationPaths: paths, herdr: f.herdr });
		assert.equal(response.isError, undefined);
		assert.equal(response.details.effectiveConcurrency, 2);
		assert.equal(new Set(response.details.tasks.map((task) => task.paneId)).size, 2);
		assert.equal(f.calls.some(([method]) => method === "focusPane"), false, "ordinary execution never steals focus");
		const create = f.calls.find(([method]) => method === "createTab")[1];
		assert.deepEqual([create.workspaceId, create.cwd, create.label, create.focus], ["fixture-workspace", f.root, "SA · configuration", false]);
		assert.equal(create.env.PI_HERDR_SUBAGENTS_CHILD, "1");
		assert.ok(create.env.PI_HERDR_SUBAGENTS_TASK_DIR.startsWith(join(f.root, ".pi", "herdr-subagents", "runs")));
		if (process.env.HERDR_PANE_ID) assert.equal(create.env.PI_HERDR_SUBAGENTS_PARENT_PANE_ID, process.env.HERDR_PANE_ID);
		assert.ok(f.calls.filter(([method]) => method === "splitPane").every(([, request]) => request.focus === false));
		const starts = f.calls.filter(([method]) => method === "startAgent");
		assert.equal(starts.length, 2);
		const actual = starts.map(([, { args }]) => {
			for (const flag of ["--approve", "--session", "--no-extensions", "--no-skills", "builtin:codemode"]) assert.ok(args.includes(flag));
			assert.ok(args.some((arg) => arg.endsWith("/extensions/subagent-report.ts")));
			assert.equal(args.includes("--print"), false);
			assert.equal(args[args.indexOf("--tools") + 1], "read,bash,codemode,subagent_report");
			assert.equal(args[args.indexOf("--thinking") + 1], "high");
			assert.equal(args[args.indexOf("--skill") + 1], "one-skill");
			assert.ok(args.includes("./provider with spaces.ts"));
			const task = readTask(join(args[args.indexOf("--session") + 1], ".."));
			assert.deepEqual([task.thinking, task.skills, task.extensions], ["high", ["one-skill"], ["./provider with spaces.ts"]]);
			assert.ok(readFileSync(join(task.sessionFile, "..", "system-prompt.md"), "utf8").startsWith("Read only"));
			return args[args.indexOf("--model") + 1];
		});
		assert.deepEqual(actual.sort(), ["model/one", "model/two"]);
		const history = await listSubagentHistory(f.root);
		assert.ok(history[0].tasks.every((task) => task.thinking === "high" && task.extensions[0] === "./provider with spaces.ts"));
	} finally {
		if (old === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = old;
		if (workspace === undefined) delete process.env.HERDR_WORKSPACE_ID; else process.env.HERDR_WORKSPACE_ID = workspace;
	}
	console.log("PASS per-task models and Persona high/skills/extensions reach real public execution, CLI arguments, task records and history");
} finally { f.close(); }

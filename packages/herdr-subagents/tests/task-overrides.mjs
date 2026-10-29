import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeHerdrSubagents } from "../src/tool.ts";
import { listSubagentHistory } from "../src/history.ts";
import { validateRunParams } from "../src/validation.ts";
import { batchFixture, readTask, writeJson } from "./fixtures/herdr.mjs";

process.env.HERDR_ENV = "1";
process.env.HERDR_WORKSPACE_ID = "test-workspace";

const cases = [
	{ name: "neither", settings: { personas: { reader: { model: "persona/model", thinking: "high" } } }, task: {}, expected: ["persona/model", "high"] },
	{ name: "model-only", settings: { personas: { reader: { model: "persona/model", thinking: "high" } } }, task: { model: "task/model" }, expected: ["task/model", "high"] },
	{ name: "thinking-only", settings: { personas: { reader: { model: "persona/model", thinking: "high" } } }, task: { thinking: "low" }, expected: ["persona/model", "low"] },
	{ name: "both", settings: { personas: { reader: { model: "persona/model", thinking: "high" } } }, task: { model: " task/model ", thinking: " off " }, expected: ["task/model", "off"] },
	{ name: "defaults", settings: { defaultModel: "default/model", defaultThinking: "medium" }, task: {}, expected: ["default/model", "medium"] },
	{ name: "override-default", settings: { defaultThinking: "medium" }, task: { thinking: "high" }, expected: ["parent/model", "high"] },
	{ name: "override-markdown", markdown: "thinking: high\n", task: { thinking: "minimal" }, expected: ["parent/model", "minimal"] },
	{ name: "parent", task: {}, expected: ["parent/model", "high"] },
	{ name: "parent-thinking-override", task: { thinking: "low" }, expected: ["parent/model", "low"] },
	{ name: "different-model", task: { model: "task/model" }, expected: ["task/model", undefined] },
	{ name: "pi-default", context: {}, task: {}, expected: [undefined, undefined] },
];
for (const scenario of cases) {
	const f = batchFixture();
	try {
		const agentsDirectory = join(f.root, "agents");
		mkdirSync(agentsDirectory);
		writeFileSync(join(agentsDirectory, "reader.md"), `---\nname: reader\ndescription: Read only\naccess: read\n${scenario.markdown ?? ""}---\nRead only.`);
		const configurationPaths = {
			globalConfig: join(f.root, "global.json"), projectConfig: join(f.root, "project.json"),
			globalAgents: join(f.root, "global-agents"), projectAgents: join(f.root, "project-agents"),
		};
		writeJson(configurationPaths.projectConfig, scenario.settings ?? {});
		const response = await executeHerdrSubagents({
			tasks: [{ name: scenario.name, prompt: "Report completion.", agent: "reader", ...scenario.task }],
		}, undefined, undefined, {
			cwd: f.root, ...(scenario.context ?? { model: { provider: "parent", id: "model" }, thinkingLevel: "high" }),
		}, { agentsDirectory, configurationPaths, herdr: f.herdr });
		assert.equal(response.isError, undefined, scenario.name);
		const args = f.calls.find(([method]) => method === "startAgent")[1].args;
		const flag = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
		assert.deepEqual([flag("--model"), flag("--thinking")], scenario.expected, `${scenario.name}: CLI`);
		const task = readTask(response.details.tasks[0].recordDirectory);
		assert.deepEqual([task.model, task.thinking], scenario.expected, `${scenario.name}: task record`);
		const history = (await listSubagentHistory(f.root))[0].tasks[0];
		assert.deepEqual([history.model, history.thinking], scenario.expected, `${scenario.name}: history`);
	} finally { f.close(); }
}
console.log("PASS optional task model/thinking overrides, independent precedence, trimming, off and unchanged inheritance through CLI, records and history");

for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
	assert.equal(validateRunParams({ tasks: [{ name: "valid", prompt: "Report completion.", agent: "reader", thinking }] }), undefined);
	assert.equal(validateRunParams({ tasks: [{ name: "trimmed", prompt: "Report completion.", agent: "reader", thinking: ` ${thinking}\t` }] }), undefined);
}

for (const thinking of ["", " \t", null, 42, false, {}, "banana", "hgih", "HIGH", "auto", "inherit", " highh "]) {
	const f = batchFixture();
	try {
		const response = await executeHerdrSubagents({
			tasks: [{ name: "invalid", prompt: "Do not start.", agent: "reader", thinking }],
		}, undefined, undefined, { cwd: f.root }, { agentsDirectory: join(f.root, "missing"), herdr: f.herdr });
		assert.equal(response.isError, true);
		if (typeof thinking === "string" && thinking.trim()) {
			assert.match(response.content[0].text, /tasks\[0\]\.thinking must be one of: off, minimal, low, medium, high, xhigh, max/);
		} else {
			assert.match(response.content[0].text, /tasks\[0\]\.thinking must be a non-empty string/);
		}
		assert.equal(f.calls.length, 0);
		assert.equal(existsSync(join(f.root, ".pi")), false);
	} finally { f.close(); }
}
console.log("PASS invalid task thinking fails before configuration loading, run creation or child startup");

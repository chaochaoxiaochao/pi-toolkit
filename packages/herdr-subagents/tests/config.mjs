import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSubagentConfiguration } from "../src/config.ts";
import { childPiArgs } from "../src/live-agent.ts";
import { executeHerdrSubagentsControl } from "../src/tool.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-default-extensions-"));
const agents = join(root, "agents");
const paths = {
	globalConfig: join(root, "global.json"),
	projectConfig: join(root, "project.json"),
	globalAgents: join(root, "global-agents"),
	projectAgents: join(root, "project-agents"),
};
const write = (path, value) => writeFileSync(path, JSON.stringify(value));
const load = () => loadSubagentConfiguration(root, agents, undefined, paths);
const persona = (configuration, name = "plain") => configuration.personas.find((entry) => entry.name === name);
try {
	mkdirSync(agents);
	for (const [name, frontmatter] of [["plain", ""], ["pinned", "extensions: ./markdown.ts\n"], ["cleared", "extensions: []\n"]]) {
		writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}\ndescription: Configuration fixture\naccess: read\n${frontmatter}---\nRead only.\n`);
	}
	assert.deepEqual(persona(load()).extensions, []);
	assert.equal(persona(load()).extensionsSource, "none");
	write(paths.globalConfig, { defaultExtensions: [" ./global.ts ", "npm:provider@1.0.0"] });
	let configuration = load();
	assert.deepEqual(configuration.settings.defaultExtensions, ["./global.ts", "npm:provider@1.0.0"]);
	assert.equal(configuration.settingSources.defaultExtensions, "global");
	assert.deepEqual(persona(configuration).extensions, configuration.settings.defaultExtensions);
	assert.equal(persona(configuration).extensionsSource, "global");
	assert.deepEqual(persona(configuration, "pinned").extensions, ["./markdown.ts"]);
	assert.deepEqual(persona(configuration, "cleared").extensions, []);

	write(paths.projectConfig, { defaultExtensions: ["./project.ts"] });
	configuration = load();
	assert.deepEqual(persona(configuration).extensions, ["./project.ts"]);
	assert.equal(persona(configuration).extensionsSource, "project");
	assert.equal(configuration.settingSources.defaultExtensions, "project");
	assert.deepEqual(persona(configuration, "pinned").extensions, ["./markdown.ts"]);
	assert.deepEqual(persona(configuration, "cleared").extensions, []);
	console.log("PASS project defaults replace global defaults; Markdown lists and [] override defaults");

	write(paths.globalConfig, { defaultExtensions: ["./global.ts"], personas: { plain: { extensions: ["./global-persona.ts"] }, pinned: { extensions: [] } } });
	assert.deepEqual(persona(load(), "pinned").extensions, []);
	assert.equal(persona(load(), "pinned").extensionsSource, "global persona");
	assert.deepEqual(persona(load()).extensions, ["./global-persona.ts"]);
	assert.equal(persona(load()).extensionsSource, "global persona");
	write(paths.projectConfig, { defaultExtensions: ["./project.ts"], personas: { plain: { extensions: ["./project-persona.ts"] }, pinned: { extensions: ["./project-persona.ts"] } } });
	assert.deepEqual(persona(load(), "pinned").extensions, ["./project-persona.ts"]);
	assert.deepEqual(persona(load()).extensions, ["./project-persona.ts"]);
	assert.equal(persona(load()).extensionsSource, "project persona");
	write(paths.projectConfig, { defaultExtensions: ["./project.ts"], personas: { plain: { extensions: [] } } });
	assert.deepEqual(persona(load()).extensions, []);
	assert.equal(persona(load()).extensionsSource, "project persona");
	console.log("PASS Persona JSON lists win over defaults and [] clears rather than inherits");

	write(paths.globalConfig, { defaultExtensions: ["./global.ts"] });
	write(paths.projectConfig, { defaultExtensions: [] });
	assert.deepEqual(load().settings.defaultExtensions, []);
	assert.deepEqual(persona(load()).extensions, []);
	assert.equal(persona(load()).extensionsSource, "project");
	assert.deepEqual(persona(load(), "pinned").extensions, ["./markdown.ts"]);
	for (const value of [null, "./invalid.ts", {}, [1], [""], [" \t "], ["./valid.ts", false]]) {
		write(paths.projectConfig, { defaultExtensions: value });
		configuration = load();
		assert.deepEqual(persona(configuration).extensions, ["./global.ts"]);
		assert.equal(configuration.settingSources.defaultExtensions, "global");
		assert.ok(configuration.diagnostics.includes("project defaultExtensions must be an array of non-empty strings"));
		write(paths.globalConfig, { defaultExtensions: value });
		write(paths.projectConfig, {});
		configuration = load();
		assert.deepEqual(persona(configuration).extensions, []);
		assert.ok(configuration.diagnostics.includes("global defaultExtensions must be an array of non-empty strings"));
		write(paths.globalConfig, { defaultExtensions: ["./global.ts"] });
	}
	console.log("PASS empty defaults clear inherited defaults; invalid lists are diagnosed without partial loading");

	write(paths.projectConfig, { defaultExtensions: ["./updated.ts"] });
	configuration = load();
	const selected = persona(configuration);
	const args = childPiArgs({ ...selected, sessionFile: join(root, "session.jsonl") }, join(root, "system.md"));
	assert.ok(args.includes("--no-extensions"));
	assert.ok(args.includes("builtin:codemode"));
	assert.ok(args.some((arg) => arg.endsWith("/extensions/subagent-report.ts")));
	assert.equal(args[args.indexOf("./updated.ts") - 1], "--extension");
	const response = await executeHerdrSubagentsControl({ action: "list" }, undefined, undefined, { cwd: root }, { agentsDirectory: agents, configurationPaths: paths });
	assert.deepEqual(response.details.agents.find(({ name }) => name === "plain").extensions, ["./updated.ts"]);
	assert.deepEqual(response.details.settings.defaultExtensions, ["./updated.ts"]);
	assert.match(response.content[0].text, /extensions: \.\/updated\.ts \[project\]/);
	write(paths.projectConfig, { defaultExtensions: [] });
	const cleared = persona(load());
	assert.deepEqual(cleared.extensions, []);
	const clearedArgs = childPiArgs({ ...cleared, sessionFile: join(root, "session.jsonl") }, join(root, "system.md"));
	assert.ok(clearedArgs.includes("builtin:codemode"));
	assert.ok(clearedArgs.some((arg) => arg.endsWith("/extensions/subagent-report.ts")));
	assert.ok(!clearedArgs.includes("./updated.ts"));
	assert.deepEqual(selected.extensions, ["./updated.ts"]);
	console.log("PASS defaults reach child arguments and control listings, reload per call, and preserve mandatory extensions");
} finally {
	rmSync(root, { recursive: true, force: true });
}

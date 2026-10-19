import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSubagentConfiguration } from "../src/config.ts";
import { childPiArgs } from "../src/live-agent.ts";
import { smokePersona } from "./real-herdr-config.mjs";

const root = mkdtempSync(join(tmpdir(), "herdr-smoke-config-"));
const agents = fileURLToPath(new URL("../agents", import.meta.url));
const paths = {
	globalConfig: join(root, "global.json"),
	projectConfig: join(root, "project.json"),
	globalAgents: join(root, "global-agents"),
	projectAgents: join(root, "project-agents"),
};
const write = (path, value) => writeFileSync(path, JSON.stringify(value));
try {
	write(paths.globalConfig, {
		maxConcurrency: 1,
		defaultModel: "openai-codex/test-model",
		defaultThinking: "high",
		defaultExtensions: ["npm:@maxiaochao/pi-openai-account-pool"],
		personas: { analyst: {
			skills: ["unrelated-skill"],
		} },
	});
	const before = readFileSync(paths.globalConfig, "utf8");
	const persona = smokePersona(root, agents, undefined, paths);
	assert.deepEqual(persona, {
		model: "openai-codex/test-model",
		thinking: "high",
		extensions: ["npm:@maxiaochao/pi-openai-account-pool"],
	});

	const fixture = join(root, "fixture.json");
	const probe = join(root, "local-package");
	write(fixture, { personas: { analyst: { ...persona, extensions: [...persona.extensions, probe] } } });
	const isolated = loadSubagentConfiguration(root, agents, undefined, { ...paths, globalConfig: fixture });
	const analyst = isolated.personas.find(({ name }) => name === "analyst");
	assert.equal(isolated.settings.maxConcurrency, 4);
	assert.equal(analyst.access, "read");
	assert.deepEqual(analyst.skills, []);
	assert.deepEqual(analyst.extensions, ["npm:@maxiaochao/pi-openai-account-pool", probe]);
	const args = childPiArgs({ ...analyst, sessionFile: join(root, "session.jsonl") }, join(root, "system.md"));
	assert.equal(args[args.indexOf("--model") + 1], "openai-codex/test-model");
	assert.ok(args.includes("--no-extensions"));
	assert.ok(args.includes("npm:@maxiaochao/pi-openai-account-pool"));
	assert.ok(args.includes(probe));
	assert.equal(readFileSync(paths.globalConfig, "utf8"), before);
	console.log("PASS smoke preserves configured model and authentication extensions without copying unrelated settings");

	write(paths.projectConfig, { personas: { analyst: {
		model: "custom/project-model",
		thinking: "low",
		extensions: ["./provider with spaces.ts", "../provider-package", "~/provider.ts", "npm:provider@1.0.0", "git:github.com/example/provider@v1", "builtin:codemode", "https://example.test/provider.git"],
	} } });
	assert.deepEqual(smokePersona(root, agents, undefined, paths), {
		model: "custom/project-model",
		thinking: "low",
		extensions: [join(root, "provider with spaces.ts"), join(root, "..", "provider-package"), "~/provider.ts", "npm:provider@1.0.0", "git:github.com/example/provider@v1", "builtin:codemode", "https://example.test/provider.git"],
	});
	console.log("PASS smoke honors project precedence and keeps local and native package sources valid in a temporary cwd");

	write(paths.projectConfig, { personas: { analyst: { extensions: [] } } });
	assert.deepEqual(smokePersona(root, agents, " custom/override-model ", paths), {
		model: "custom/override-model",
		thinking: "high",
		extensions: [],
	});
	mkdirSync(paths.globalAgents, { recursive: true });
	writeFileSync(join(paths.globalAgents, "analyst.md"), "---\nname: analyst\ndescription: Custom user analyst\naccess: write\ntools: write\n---\nUnrelated user prompt.\n");
	const selected = smokePersona(root, agents, undefined, paths);
	assert.deepEqual(Object.keys(selected).sort(), ["extensions", "model", "thinking"]);
	assert.equal(selected.model, "openai-codex/test-model");
	console.log("PASS smoke supports model overrides and explicit extension clearing without copying Persona tools or prompts");
} finally {
	rmSync(root, { recursive: true, force: true });
}

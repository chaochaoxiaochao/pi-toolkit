import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childPiArgs } from "../src/live-agent.ts";
import { loadSubagentConfiguration } from "../src/config.ts";
import { fileURLToPath } from "node:url";

// Exercise native Pi package semantics without provider calls or network installs.
const root = mkdtempSync(join(tmpdir(), "pi-herdr-extension-sources-"));
try {
	const packageDirectory = join(root, "local package");
	mkdirSync(join(packageDirectory, "skills", "package-skill"), { recursive: true });
	mkdirSync(join(packageDirectory, "prompts"), { recursive: true });
	writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
		name: "extension-source-fixture",
		pi: { extensions: ["extension.ts"], skills: ["skills"], prompts: ["prompts"] },
	}));
	writeFileSync(join(packageDirectory, "extension.ts"), `export default function (pi) {
		pi.registerCommand("package-extension", { description: "Package extension loaded", handler() {} });
		pi.registerTool({
			name: "apply_patch", label: "Patch editor probe", description: "Editing protocol selection probe",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			async execute() { return { content: [], details: {} }; },
		});
		pi.on("session_start", () => {
			const active = pi.getActiveTools();
			if (active.includes("edit")) pi.setActiveTools([...active.filter((name) => name !== "edit"), "apply_patch"]);
		});
	}`);
	writeFileSync(join(packageDirectory, "skills", "package-skill", "SKILL.md"), "---\nname: package-skill\ndescription: Package skill loading probe\n---\n# Probe\n");
	writeFileSync(join(packageDirectory, "prompts", "package-prompt.md"), "Package prompt loading probe.");
	const fileExtension = join(root, "file extension.ts");
	writeFileSync(fileExtension, `export default function (pi) {
		pi.registerCommand("file-extension", { description: "File extension loaded", handler() {} });
	}`);
	const probe = join(root, "probe.ts");
	const resultPath = join(root, "result.json");
	writeFileSync(probe, `import { writeFileSync } from "node:fs";
		export default function (pi) {
			pi.on("session_start", (_event, ctx) => {
				writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
					commands: pi.getCommands().map((command) => command.name),
					tools: pi.getActiveTools(),
				}));
				ctx.shutdown();
			});
		}`);
	const globalConfig = join(root, "global.json");
	writeFileSync(globalConfig, JSON.stringify({ defaultExtensions: [fileExtension, "./local package", probe] }));
	const configuration = loadSubagentConfiguration(root, fileURLToPath(new URL("../agents", import.meta.url)), undefined, { globalConfig, globalAgents: join(root, "global-agents") });
	const analyst = configuration.personas.find(({ name }) => name === "analyst");
	assert.equal(analyst.extensionsSource, "global");
	const args = childPiArgs({ id: "probe", sessionFile: join(root, "session.jsonl"), tools: ["read"], extensions: analyst.extensions }, join(root, "system.md"));
	// `builtin:codemode` is translated by `herdr agent start` and is covered by
	// the real-Herdr smoke test. Direct Pi has no portable form of that alias.
	const codemode = args.indexOf("builtin:codemode");
	args.splice(codemode - 1, 2);
	writeFileSync(join(root, "system.md"), "Extension source loading probe.");
	const env = { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_HERDR_SUBAGENTS_CHILD: "1" };
	for (const key of Object.keys(env)) if (key.startsWith("HERDR_") || key === "PI_HERDR_SUBAGENTS_TASK_DIR" || key === "PI_HERDR_SUBAGENTS_PARENT_PANE_ID") delete env[key];
	const result = spawnSync(process.env.PI_TEST_BINARY?.trim() || "pi", [...args, "--offline"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
	assert.equal(result.error, undefined, String(result.error));
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const loaded = JSON.parse(readFileSync(resultPath, "utf8"));
	for (const command of ["file-extension", "package-extension", "skill:package-skill", "package-prompt", "parent"]) assert.ok(loaded.commands.includes(command), `Missing ${command}: ${JSON.stringify(loaded)}`);
	assert.deepEqual([...loaded.tools].sort(), ["read", "subagent_report"]);
	console.log("PASS real Pi loads defaultExtensions file and package sources, including package skills/prompts despite discovery flags, without broadening the direct-Pi tool allowlist");

	for (const [id, tools, extensions, expected] of [
		["patch-editor", ["read", "edit", "write"], analyst.extensions, ["read", "write", "apply_patch", "subagent_report"]],
		["no-editor", ["read", "write"], analyst.extensions, ["read", "write", "subagent_report"]],
		["native-editor", ["read", "edit", "write"], [fileExtension, probe], ["read", "edit", "write", "subagent_report"]],
	]) {
		const childArgs = childPiArgs({ id, sessionFile: join(root, `${id}.jsonl`), tools, extensions }, join(root, "system.md"));
		const builtin = childArgs.indexOf("builtin:codemode");
		childArgs.splice(builtin - 1, 2);
		const child = spawnSync(process.env.PI_TEST_BINARY?.trim() || "pi", [...childArgs, "--offline"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
		assert.equal(child.error, undefined, String(child.error));
		assert.equal(child.status, 0, child.stderr || child.stdout);
		const actual = JSON.parse(readFileSync(resultPath, "utf8"));
		assert.deepEqual([...actual.tools].sort(), [...expected].sort(), `${id}: the real CLI must preserve the selected editing protocol`);
	}
	console.log("PASS real Pi CLI permits apply_patch for edit-capable children, preserves native fallback, and denies it to read-only/no-editor children");
} finally {
	rmSync(root, { recursive: true, force: true });
}

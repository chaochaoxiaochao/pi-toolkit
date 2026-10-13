import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childPiArgs } from "../src/live-agent.ts";

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
	const args = childPiArgs({ id: "probe", sessionFile: join(root, "session.jsonl"), tools: ["read"], extensions: [fileExtension, "./local package", probe] }, join(root, "system.md"));
	writeFileSync(join(root, "system.md"), "Extension source loading probe.");
	const env = { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_HERDR_SUBAGENTS_CHILD: "1" };
	for (const key of Object.keys(env)) if (key.startsWith("HERDR_") || key === "PI_HERDR_SUBAGENTS_TASK_DIR" || key === "PI_HERDR_SUBAGENTS_PARENT_PANE_ID") delete env[key];
	const result = spawnSync(process.env.PI_TEST_BINARY?.trim() || "pi", [...args, "--offline", "--no-mcp"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
	assert.equal(result.error, undefined, String(result.error));
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const loaded = JSON.parse(readFileSync(resultPath, "utf8"));
	for (const command of ["file-extension", "package-extension", "skill:package-skill", "package-prompt", "parent"]) assert.ok(loaded.commands.includes(command), `Missing ${command}: ${JSON.stringify(loaded)}`);
	assert.deepEqual([...loaded.tools].sort(), ["codemode", "read", "subagent_report"]);
	console.log("PASS real Pi loads explicit file and package sources, including package skills/prompts despite discovery flags, without broadening the tool allowlist");
} finally {
	rmSync(root, { recursive: true, force: true });
}

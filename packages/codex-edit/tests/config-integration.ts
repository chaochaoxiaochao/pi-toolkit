import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerCodexEdit from "../extensions/codex-edit.ts";

async function editor(tools = ["read", "bash", "edit", "write"]) {
  let active = [...tools];
  let tool;
  let status;
  const handlers = new Map();
  await registerCodexEdit({
    registerTool(definition) { tool = definition; },
    on(event, handler) { handlers.set(event, handler); },
    getActiveTools() { return active; },
    setActiveTools(next) { active = next; },
  });
  return {
    tool,
    active: () => active,
    status: () => status,
    async start(model, cwd) {
      await handlers.get("session_start")({}, {
        model, cwd, hasUI: true,
        ui: { setStatus(key, value) { assert.equal(key, "codex-edit"); status = value; } },
      });
    },
    async select(model) {
      await handlers.get("model_select")({ model }, { hasUI: false });
    },
  };
}

export default async function () {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-edit-integration-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const configPath = join(agentDir, "codex-edit.json");
  const model = { id: "gpt-6.1-sol", api: "openai-codex-responses" };
  try {
    await writeFile(configPath, JSON.stringify({ models: [model.id] }));
    const parent = await editor();
    const child = await editor();
    for (const [session, cwd] of [[parent, "/parent-project"], [child, "/child-worktree"]]) {
      await session.start(model, cwd);
      assert.equal(session.status(), "editor: apply_patch");
      assert.deepEqual(session.active(), ["read", "bash", "write", "apply_patch"]);
      await session.select({ ...model, id: "gpt-5.6-sol" });
      assert.ok(session.active().includes("edit"), "user list must replace defaults");
      await session.select({ ...model, api: "openai-completions" });
      assert.ok(session.active().includes("edit"), "unsupported API must retain edit");
      await session.select(model);
      assert.ok(!session.active().includes("edit"));
    }
    await child.tool.execute("config-patch", {
      patch: "*** Begin Patch\n*** Add File: proof.txt\n+shared user config\n*** End Patch",
    }, undefined, undefined, { cwd: agentDir });
    assert.equal(await readFile(join(agentDir, "proof.txt"), "utf8"), "shared user config\n");

    const readonly = await editor(["read", "bash"]);
    await readonly.start(model, agentDir);
    assert.deepEqual(readonly.active(), ["read", "bash"]);

    await writeFile(configPath, JSON.stringify({ enabled: false }));
    const reloaded = await editor();
    await reloaded.start(model, agentDir);
    assert.equal(reloaded.status(), "editor: edit");
    assert.ok(!reloaded.active().includes("apply_patch"));

    await writeFile(configPath, "{");
    await assert.rejects(editor(), (error) => error.message.includes(configPath));
    console.log("Codex Edit user config: shared parent/child routing, patch execution, read-only tools, reload and invalid-config checks passed");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
}

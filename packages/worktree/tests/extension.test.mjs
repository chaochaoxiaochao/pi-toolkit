import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = await mkdtemp(join(tmpdir(), "pi-worktree-extension-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const { default: register, WORKTREE_SWITCH_REQUEST } = await import("../extensions/worktree.ts");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup(prepared) {
  const commands = new Map();
  const tools = new Map();
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
    async exec(command, args, options) {
      assert.match(command, /packages\/worktree\/bin\/pi-worktree$/);
      assert.deepEqual(args, ["prepare", "--json", "--base", "main", "feature"]);
      assert.equal(options.cwd, prepared.cwd);
      return { code: 0, stdout: `${JSON.stringify(prepared.result)}\n`, stderr: "" };
    },
  };
  register(pi);
  return { commands, tools };
}

test("registers /worktree and switches a forked persistent session", async () => {
  const cwd = join(root, "main");
  const target = join(root, "main", ".worktrees", "feature");
  await mkdir(target, { recursive: true });
  const sourceSession = join(root, "source.jsonl");
  await writeFile(sourceSession, `${JSON.stringify({ type: "session", version: 3, id: "source", timestamp: new Date().toISOString(), cwd })}\n`);
  const prepared = { cwd, result: { status: "created", path: target, branch: "feature", dirty: false } };
  const { commands } = setup(prepared);
  const notifications = [];
  let switchedFile;
  await commands.get("worktree").handler("start feature --base main", {
    cwd,
    sessionManager: { getSessionFile: () => sourceSession },
    waitForIdle: async () => {},
    ui: { notify: (...args) => notifications.push(args) },
    async switchSession(file, options) {
      switchedFile = file;
      await options.withSession({ ui: { notify: (...args) => notifications.push(args) } });
      return { cancelled: false };
    },
  });

  const header = JSON.parse((await readFile(switchedFile, "utf8")).split("\n")[0]);
  assert.equal(header.cwd, target);
  assert.equal(header.parentSession, sourceSession);
  assert.deepEqual(notifications.at(-1), [`已切换到 feature：${target}`, "success"]);
});

test("removes the forked session when /worktree switching is cancelled", async () => {
  const cwd = join(root, "cancel-main");
  const target = join(cwd, ".worktrees", "feature");
  await mkdir(target, { recursive: true });
  const sourceSession = join(root, "cancel-source.jsonl");
  await writeFile(sourceSession, `${JSON.stringify({ type: "session", version: 3, id: "cancel-source", timestamp: new Date().toISOString(), cwd })}\n`);
  const prepared = { cwd, result: { status: "created", path: target, branch: "feature", dirty: false } };
  const { commands } = setup(prepared);
  const notifications = [];
  let forkedFile;
  await commands.get("worktree").handler("start feature --base main", {
    cwd,
    sessionManager: { getSessionFile: () => sourceSession },
    waitForIdle: async () => {},
    ui: { notify: (...args) => notifications.push(args) },
    async switchSession(file) {
      forkedFile = file;
      return { cancelled: true };
    },
  });

  await assert.rejects(readFile(forkedFile, "utf8"), { code: "ENOENT" });
  assert.deepEqual(notifications.at(-1), ["worktree 会话切换已取消", "warning"]);
});

test("registers enter_worktree with a durable Harness switch request", async () => {
  const cwd = join(root, "main");
  const target = join(cwd, ".worktrees", "feature");
  const sourceSession = join(root, "tool-source.jsonl");
  const prepared = { cwd, result: { status: "reused", path: target, branch: "feature", dirty: true } };
  const { tools } = setup(prepared);
  const tool = tools.get("enter_worktree");
  assert.equal(tool.exposure, "model-only");
  assert.ok(tool.outputSchema);
  const result = await tool.execute(
    "call-1",
    { name: "feature", base: "main" },
    new AbortController().signal,
    undefined,
    { cwd, sessionManager: { getSessionFile: () => sourceSession } },
  );

  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, {
    kind: WORKTREE_SWITCH_REQUEST,
    version: 1,
    action: "fork-and-switch",
    sessionFile: sourceSession,
    status: "reused",
    path: target,
    branch: "feature",
    dirty: true,
  });
  assert.deepEqual(result.structuredContent, result.details);
});

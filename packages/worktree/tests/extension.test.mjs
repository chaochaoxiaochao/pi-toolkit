import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const extensionUrl = pathToFileURL(
  join(import.meta.dirname, "..", "extensions", "worktree.ts"),
).href;

function sourceSession(path, cwd) {
  const timestamp = new Date().toISOString();
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: "source", timestamp, cwd }),
    JSON.stringify({ type: "message", id: "history-1", parentId: null, timestamp, message: { role: "user", content: "preserve me", timestamp: Date.now() } }),
    "",
  ].join("\n"));
}

async function fixture({ cancelled = false, switchError, customSessionDir = true, deferExec = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-extension-"));
  const cwd = join(root, "repo");
  const worktree = join(root, "feature");
  const sessions = join(root, "sessions");
  mkdirSync(cwd);
  mkdirSync(worktree);
  mkdirSync(sessions);
  const source = join(sessions, "source.jsonl");
  sourceSession(source, cwd);

  const handlers = {};
  const sent = [];
  const sessionMessages = [];
  const notifications = [];
  const execCalls = [];
  let releaseExec;
  let markExecStarted;
  const execStarted = new Promise(resolve => { markExecStarted = resolve; });
  const pi = {
    on(event, handler) { handlers[event] = handler; },
    registerCommand(name, command) { handlers[`command:${name}`] = command.handler; },
    registerTool(tool) { handlers.tool = tool; },
    async exec(command, args, options) {
      execCalls.push({ command, args, options });
      assert.equal(options.cwd, cwd);
      markExecStarted();
      if (deferExec) await new Promise(resolve => { releaseExec = resolve; });
      return {
        code: 0,
        stdout: JSON.stringify({ status: "created", path: worktree, branch: "feature", dirty: false }),
        stderr: "",
      };
    },
    sendUserMessage(message, options) { sent.push({ message, options }); },
  };

  const extension = (await import(`${extensionUrl}?test=${Math.random()}`)).default;
  extension(pi);

  let switchedTo;
  const ctx = {
    cwd,
    sessionManager: {
      getSessionFile: () => source,
      usesDefaultSessionDir: () => !customSessionDir,
      getSessionDir: () => sessions,
    },
    ui: { notify: (message, type) => notifications.push({ message, type }) },
    async waitForIdle() {},
    async switchSession(path, options) {
      switchedTo = path;
      if (cancelled) return { cancelled: true };
      if (switchError) throw switchError;
      await options.withSession({
        ui: ctx.ui,
        async sendMessage(message, options) { sessionMessages.push({ message, options }); },
      });
      return { cancelled: false };
    },
  };

  return {
    root, cwd, worktree, sessions, handlers, sent, sessionMessages, notifications, execCalls, ctx,
    execStarted,
    releaseExec: () => releaseExec(),
    switchedTo: () => switchedTo,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function schedule(f) {
  const result = await f.handlers.tool.execute(
    "call-1",
    { name: "feature" },
    new AbortController().signal,
    undefined,
    f.ctx,
  );
  assert.equal(result.details.switch, "scheduled");
  assert.equal(f.handlers.tool.executionMode, "sequential");
}

test("enter_worktree defers, forks the current session, and switches automatically", async () => {
  const f = await fixture();
  try {
    await schedule(f);
    await f.handlers.agent_settled({ aborted: false });
    assert.deepEqual(f.sent, [{
      message: "/worktree __enter_worktree_pending__",
      options: { expandPromptTemplates: true },
    }]);

    const internalArg = f.sent[0].message.slice("/worktree ".length);
    await f.handlers["command:worktree"](internalArg, f.ctx);

    const target = f.switchedTo();
    assert.ok(target);
    assert.equal(dirname(target), f.sessions, "custom session directory is preserved");
    const header = JSON.parse(readFileSync(target, "utf8").split("\n")[0]);
    assert.equal(header.cwd, f.worktree);
    assert.equal(header.parentSession, join(f.sessions, "source.jsonl"));
    assert.match(readFileSync(target, "utf8"), /"id":"history-1"/);
    assert.deepEqual(f.sessionMessages, [{
      message: {
        customType: "worktree-switch",
        content: `✓ 已进入 worktree：${f.worktree}\nBranch: feature\n\n在worktree继续任务`,
        display: true,
        details: { status: "created", path: f.worktree, branch: "feature", dirty: false },
      },
      options: { triggerTurn: true, deliverAs: "followUp" },
    }]);
  } finally {
    f.cleanup();
  }
});

test("public /worktree forwards --base to the CLI and switches", async () => {
  const f = await fixture();
  try {
    await f.handlers["command:worktree"]("start feature --base main", f.ctx);
    assert.match(f.execCalls[0].command, /packages\/worktree\/bin\/pi-worktree$/);
    assert.deepEqual(f.execCalls[0].args, ["prepare", "--json", "--base", "main", "feature"]);
    assert.equal(f.execCalls[0].options.cwd, f.cwd);
    assert.ok(f.switchedTo());
  } finally {
    f.cleanup();
  }
});

test("aborted agent settlement discards the scheduled switch", async () => {
  const f = await fixture();
  try {
    await schedule(f);
    await f.handlers.agent_settled({ aborted: true });
    assert.equal(f.sent.length, 0);
  } finally {
    f.cleanup();
  }
});

test("a user command cannot race an Agent tool that is still preparing", async () => {
  const f = await fixture({ deferExec: true });
  try {
    const toolResult = f.handlers.tool.execute(
      "call-race",
      { name: "feature" },
      new AbortController().signal,
      undefined,
      f.ctx,
    );
    await f.execStarted;
    await f.handlers["command:worktree"]("start other", f.ctx);
    assert.equal(f.execCalls.length, 1);
    assert.equal(f.switchedTo(), undefined);
    assert.equal(f.notifications.at(-1).type, "warning");
    f.releaseExec();
    await toolResult;
    await f.handlers.agent_settled({ aborted: true });
  } finally {
    f.cleanup();
  }
});

test("cancelling session replacement deletes the derived session", async () => {
  const f = await fixture({ cancelled: true });
  try {
    await schedule(f);
    await f.handlers.agent_settled({ aborted: false });
    await f.handlers["command:worktree"]("__enter_worktree_pending__", f.ctx);

    assert.equal(existsSync(f.switchedTo()), false);
    assert.match(f.notifications.at(-1).message, /切换已取消/);
    assert.equal(f.notifications.at(-1).type, "warning");
  } finally {
    f.cleanup();
  }
});

test("a replacement error does not delete a session that may already be active", async () => {
  const f = await fixture({ switchError: new Error("host rebind failed") });
  try {
    await schedule(f);
    await f.handlers.agent_settled({ aborted: false });
    await assert.rejects(
      f.handlers["command:worktree"]("__enter_worktree_pending__", f.ctx),
      /host rebind failed/,
    );
    assert.equal(existsSync(f.switchedTo()), true);
  } finally {
    f.cleanup();
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import registerReport from "../extensions/subagent-report.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-report-boundary-"));
const previous = process.env.PI_HERDR_SUBAGENTS_TASK_DIR;
process.env.PI_HERDR_SUBAGENTS_TASK_DIR = root;
const sessionFile = join(root, "session.jsonl");
writeFileSync(sessionFile, "");
mkdirSync(join(root, ".pi"));
writeFileSync(join(root, ".pi", "herdr-subagents.json"), JSON.stringify({ abortGraceSeconds: 1 }));
const ctx = { cwd: root, sessionManager: { getSessionFile: () => sessionFile }, isIdle: () => true };
function fixture() {
  const handlers = new Map();
  let tool;
  registerReport({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (value) => { tool = value; },
    registerCommand() {}, registerShortcut() {}, events: { on() {} },
  });
  return { handlers, tool };
}
function attempt() {
  const id = randomUUID();
  writeFileSync(join(root, "task.json"), JSON.stringify({ currentAttemptId: id }));
  return { id, report: join(root, "reports", `${id}.json`) };
}
const boundary = (outcome = "completed") => ({ outcome, entries: [], continue: false, context: { canContinue: true } });
try {
  const f = fixture();
  assert.equal(typeof f.handlers.get("agent_before_settle"), "function", "child must handle the real pre-settlement boundary");
  for (const status of ["completed", "failed"]) {
    const a = attempt();
    await f.handlers.get("before_agent_start")();
    const input = { status, summary: status, result: "Already done", ...(status === "failed" ? { error: "Expected" } : {}) };
    await f.tool.execute("first", input);
    const original = readFileSync(a.report, "utf8");
    assert.equal(await f.handlers.get("agent_before_settle")(boundary(), ctx), undefined);
    await f.tool.execute("repeat", input);
    await assert.rejects(() => f.tool.execute("conflict", { ...input, summary: "different" }), /Conflicting/);
    assert.equal(readFileSync(a.report, "utf8"), original, "normal and failed reports need no extra request or replacement");
  }
  const a = attempt();
  await f.handlers.get("before_agent_start")();
  const reminder = await f.handlers.get("agent_before_settle")(boundary(), ctx);
  assert.equal(reminder.continue, true);
  assert.match(JSON.stringify(reminder.entries), /Do not redo|do not redo/);
  assert.equal(existsSync(a.report), false, "a reminder is not a completion report");
  // A new round and even extension reload must not reset the per-attempt budget.
  const reloaded = fixture();
  await reloaded.handlers.get("before_agent_start")();
  assert.equal(await reloaded.handlers.get("agent_before_settle")(boundary(), ctx), undefined);
  const diagnostic = JSON.parse(readFileSync(a.report, "utf8"));
  assert.equal(diagnostic.status, "failed");
  assert.equal(diagnostic.error, "missing_report");
  assert.match(diagnostic.summary, /unconfirmed/);
  assert.ok(diagnostic.documents.some(({ path }) => path === sessionFile));
  assert.equal(await reloaded.handlers.get("agent_before_settle")(boundary(), ctx), undefined);

  {
    const current = attempt();
    const run = fixture();
    await run.handlers.get("before_agent_start")();
    assert.equal(await run.handlers.get("agent_before_settle")(boundary("aborted"), ctx), undefined);
    assert.equal(existsSync(current.report), false, "Esc abort must not publish a terminal report; the user may steer");
  }
  {
    // Esc skips before-settle and only emits agent_settled(aborted). Grace period, configurable.
    const current = attempt();
    const run = fixture();
    await run.handlers.get("before_agent_start")();
    await run.handlers.get("agent_settled")({ aborted: true }, ctx);
    assert.equal(existsSync(current.report), false, "no report inside the grace period");
    await run.handlers.get("before_agent_start")(); // user steers: timer must be cancelled
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(existsSync(current.report), false, "steering within the grace period cancels the diagnostic");
    await run.handlers.get("agent_settled")({ aborted: true }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const report = JSON.parse(readFileSync(current.report, "utf8"));
    assert.equal(report.error, "child_aborted");
    assert.match(report.summary, /unconfirmed/);
    const shutdown = fixture(); // shutdown must clear a pending timer
    const other = attempt();
    await shutdown.handlers.get("before_agent_start")();
    await shutdown.handlers.get("agent_settled")({ aborted: true }, ctx);
    shutdown.handlers.get("session_shutdown")();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(existsSync(other.report), false, "session shutdown clears the grace timer");
  }
  {
    const current = attempt();
    const run = fixture();
    await run.handlers.get("before_agent_start")();
    assert.equal(await run.handlers.get("agent_before_settle")(boundary("error"), ctx), undefined, "error: do not wake or retry the child");
    const report = JSON.parse(readFileSync(current.report, "utf8"));
    assert.equal(report.status, "failed");
    assert.equal(report.error, "child_error");
    assert.match(report.summary, /unconfirmed/);
  }
  const repaired = attempt();
  const run = fixture();
  await run.handlers.get("before_agent_start")();
  assert.equal((await run.handlers.get("agent_before_settle")(boundary(), ctx)).continue, true);
  await run.tool.execute("repair", { status: "completed", summary: "Recovered existing work", result: "Existing result" });
  assert.equal(await run.handlers.get("agent_before_settle")(boundary(), ctx), undefined);
  assert.equal(JSON.parse(readFileSync(repaired.report, "utf8")).status, "completed");
  console.log("PASS report boundary: zero-request completion, one durable reminder, unconfirmed failure, cancellation/error, idempotency");
} finally {
  if (previous === undefined) delete process.env.PI_HERDR_SUBAGENTS_TASK_DIR;
  else process.env.PI_HERDR_SUBAGENTS_TASK_DIR = previous;
  rmSync(root, { recursive: true, force: true });
}

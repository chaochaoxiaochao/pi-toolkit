#!/usr/bin/env node
import { mkdirSync, openSync, closeSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const captureRoot = resolve(process.argv[2] ?? join(root, ".cache", "package-media"));
const frameDir = join(captureRoot, "herdr-live");
const windowId = process.env.HERDR_MEDIA_WINDOW_ID;
const workspaceId = process.env.HERDR_WORKSPACE_ID;
const model = process.env.PI_HERDR_MEDIA_MODEL ?? "pudu/gpt-5.6-sol";

if (process.env.HERDR_ENV !== "1" || !workspaceId) {
  throw new Error("Herdr Subagents UI capture must run from a Pi session inside Herdr.");
}
if (!windowId) {
  throw new Error("Set HERDR_MEDIA_WINDOW_ID to the X11 window ID of the visible Herdr client (for example, 0x720000a).");
}

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const herdr = (args) => JSON.parse(execFileSync("herdr", args, { cwd: root, encoding: "utf8" }));
const tabs = () => herdr(["tab", "list", "--workspace", workspaceId]).result.tabs;
const capture = (index) => {
  const path = join(frameDir, `frame-${String(index).padStart(3, "0")}.png`);
  execFileSync("import", ["-window", windowId, path], { stdio: "ignore" });
};

rmSync(frameDir, { recursive: true, force: true });
mkdirSync(frameDir, { recursive: true });

const existingTabs = new Set(tabs().map((tab) => tab.tab_id));
const created = herdr(["tab", "create", "--workspace", workspaceId, "--cwd", root, "--label", "Herdr Subagents Demo", "--no-focus"]);
const parentTab = created.result.tab.tab_id;
const parentPane = created.result.root_pane.pane_id;
const parentName = `media_parent_${process.pid}`;
let promptProcess;
let promptExit;

try {
  herdr([
    "agent", "start", parentName, "--kind", "pi", "--pane", parentPane, "--timeout", "90000", "--",
    "--no-extensions", "--no-skills", "--no-session", "--no-context-files", "--no-builtin-tools",
    "--extension", "./packages/herdr-subagents/extensions/herdr-subagents.ts", "--model", model,
  ]);
  herdr(["tab", "focus", parentTab]);
  await sleep(1_000);
  capture(0);

  const prompt = [
    "Use herdr_subagents to run a foreground read-only batch with concurrency 3.",
    "Create exactly three explorer tasks named API, Recovery, and Tests.",
    "Inspect packages/herdr-subagents/src/tool.ts, packages/herdr-subagents/src/reconcile.ts,",
    "and packages/herdr-subagents/tests/extension-contract.ts respectively.",
    "Return one concise sentence per task, then summarize all three findings in one line.",
  ].join(" ");
  const stdout = openSync(join(frameDir, "parent-prompt.json"), "w");
  const stderr = openSync(join(frameDir, "parent-prompt.stderr"), "w");
  promptProcess = spawn("herdr", ["agent", "prompt", parentName, prompt, "--wait", "--timeout", "420000"], {
    cwd: root,
    stdio: ["ignore", stdout, stderr],
  });
  promptProcess.once("exit", (code, signal) => {
    closeSync(stdout);
    closeSync(stderr);
    promptExit = { code, signal };
  });

  await sleep(700);
  capture(1);

  let runTab;
  for (let attempt = 0; attempt < 150; attempt++) {
    runTab = tabs().find((tab) => !existingTabs.has(tab.tab_id) && tab.tab_id !== parentTab && tab.label.startsWith("SA ·"));
    if (runTab) break;
    await sleep(400);
  }
  if (!runTab) throw new Error("The parent Pi did not create a Herdr Subagents run tab within 60 seconds.");

  herdr(["tab", "focus", runTab.tab_id]);
  await sleep(700);
  capture(2);
  let frame = 3;
  for (let index = 0; index < 18; index++) {
    await sleep(2_000);
    capture(frame++);
    if (promptExit) break;
  }
  if (!promptExit) {
    await new Promise((resolveExit) => promptProcess.once("exit", resolveExit));
  }
  if (promptExit?.code !== 0) {
    throw new Error(`The parent Pi demo prompt failed (${promptExit?.signal ?? promptExit?.code ?? "unknown"}).`);
  }

  capture(frame++);
  herdr(["tab", "focus", parentTab]);
  await sleep(1_500);
  capture(frame);
} finally {
  if (promptProcess && !promptExit) promptProcess.kill("SIGTERM");
  try { herdr(["tab", "close", parentTab]); } catch { /* The demo tab may already be gone. */ }
}

console.log(`Captured live Herdr parent and subagent UI frames in ${frameDir}`);

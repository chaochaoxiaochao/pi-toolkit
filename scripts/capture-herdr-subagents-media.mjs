#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const captureRoot = resolve(process.argv[2] ?? join(root, ".cache", "package-media"));
const frameDir = join(captureRoot, "herdr-live");
const videoPath = join(captureRoot, "herdr-demo.webm");
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
const panes = () => herdr(["pane", "list", "--workspace", workspaceId]).result.panes;
const originalFocusedAgent = herdr(["agent", "list"]).result.agents.find((agent) => agent.focused);
const originalFocusedWorkspace = herdr(["workspace", "list"]).result.workspaces.find((workspace) => workspace.focused);
const originalFocusedTab = originalFocusedAgent?.tab_id ?? originalFocusedWorkspace?.active_tab_id;
const runRoot = join(root, ".pi", "herdr-subagents", "runs");
const currentRunMetrics = (tabId) => {
  if (!existsSync(runRoot)) return { active: false, hasUsage: false };
  for (const entry of readdirSync(runRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(runRoot, entry.name);
    try {
      const run = JSON.parse(readFileSync(join(directory, "run.json"), "utf8"));
      if (run.tabId !== tabId) continue;
      const taskRoot = join(directory, "tasks");
      let active = false;
      let hasUsage = false;
      for (const taskEntry of readdirSync(taskRoot, { withFileTypes: true })) {
        if (!taskEntry.isDirectory()) continue;
        const taskDirectory = join(taskRoot, taskEntry.name);
        const task = JSON.parse(readFileSync(join(taskDirectory, "task.json"), "utf8"));
        active ||= ["starting", "queued", "running", "blocked"].includes(task.status);
        const sessionFile = join(taskDirectory, "session.jsonl");
        if (!existsSync(sessionFile)) continue;
        for (const line of readFileSync(sessionFile, "utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            const usage = record.type === "message" ? record.message?.usage : record.usage;
            if (usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some((value) => Number(value) > 0)) hasUsage = true;
          } catch { /* A live session can end in a partial JSONL line. */ }
        }
      }
      return { active, hasUsage };
    } catch { /* Ignore unrelated stale or partially-written records. */ }
  }
  return { active: false, hasUsage: false };
};
const capture = (index, alias) => {
  const path = join(frameDir, `frame-${String(index).padStart(3, "0")}.png`);
  execFileSync("import", ["-window", windowId, path], { stdio: "ignore" });
  if (alias) copyFileSync(path, join(captureRoot, alias));
};

rmSync(frameDir, { recursive: true, force: true });
rmSync(videoPath, { force: true });
mkdirSync(frameDir, { recursive: true });

const existingTabs = new Set(tabs().map((tab) => tab.tab_id));
const created = herdr(["tab", "create", "--workspace", workspaceId, "--cwd", root, "--label", "Herdr Subagents Demo", "--no-focus"]);
const parentTab = created.result.tab.tab_id;
const parentPane = created.result.root_pane.pane_id;
const parentName = `media_parent_${process.pid}`;
let promptProcess;
let promptExit;
let videoProcess;
let videoExit;
let videoDone;

const stopVideo = async () => {
  if (!videoProcess) return;
  if (!videoExit) videoProcess.kill("SIGINT");
  await videoDone;
  if (videoExit?.code !== 0 && videoExit?.signal !== "SIGINT") {
    throw new Error(`The Herdr screen recorder failed (${videoExit?.signal ?? videoExit?.code ?? "unknown"}).`);
  }
};

try {
  herdr([
    "agent", "start", parentName, "--kind", "pi", "--pane", parentPane, "--timeout", "90000", "--",
    "--no-extensions", "--no-skills", "--no-session", "--no-context-files", "--no-builtin-tools",
    "--extension", "./packages/herdr-subagents/extensions/herdr-subagents.ts", "--model", model,
  ]);
  herdr(["tab", "focus", parentTab]);
  await sleep(1_000);
  capture(0);

  const videoLog = openSync(join(frameDir, "video.stderr"), "w");
  videoProcess = spawn("gst-launch-1.0", [
    "-e", "-q",
    "ximagesrc", `xid=${Number.parseInt(windowId, 0)}`, "use-damage=false", "show-pointer=false",
    "!", "video/x-raw,framerate=10/1",
    "!", "videoscale", "!", "video/x-raw,width=1280,height=728",
    "!", "videoconvert",
    "!", "vp8enc", "deadline=1", "cpu-used=8", "threads=4", "target-bitrate=1400000", "keyframe-max-dist=30",
    "!", "webmmux", "!", "filesink", `location=${videoPath}`,
  ], { cwd: root, stdio: ["ignore", "ignore", videoLog] });
  videoDone = new Promise((resolveExit) => {
    videoProcess.once("exit", (code, signal) => {
      closeSync(videoLog);
      videoExit = { code, signal };
      resolveExit();
    });
  });
  await sleep(2_000);

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
  let childPanes = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    childPanes = panes().filter((pane) => pane.tab_id === runTab.tab_id);
    if (childPanes.length === 3) break;
    await sleep(300);
  }
  if (childPanes.length !== 3) {
    throw new Error(`Expected three Herdr Subagents panes, found ${childPanes.length}.`);
  }

  await sleep(500);
  capture(2);
  let frame = 3;
  for (const pane of childPanes) {
    try {
      herdr(["agent", "focus", pane.pane_id]);
      await sleep(1_000);
      capture(frame++);
    } catch { /* A very fast child may settle before its pane is focused. */ }
  }

  // Return to the parent while the children are active so the published screenshot
  // demonstrates the live Fleet footer rather than only the child panes. Prefer a
  // moment after one child has recorded authoritative usage while siblings still run.
  herdr(["tab", "focus", parentTab]);
  for (let attempt = 0; attempt < 40; attempt++) {
    const metrics = currentRunMetrics(runTab.tab_id);
    if (metrics.active && metrics.hasUsage) break;
    await sleep(500);
  }
  await sleep(750);
  capture(frame++, "herdr-fleet.png");

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
  await sleep(3_000);
  capture(frame);
  await stopVideo();
} finally {
  if (promptProcess && !promptExit) promptProcess.kill("SIGTERM");
  if (videoProcess && !videoExit) {
    try { await stopVideo(); } catch { videoProcess.kill("SIGKILL"); }
  }
  try { herdr(["tab", "close", parentTab]); } catch { /* The demo tab may already be gone. */ }
  try {
    if (originalFocusedAgent) herdr(["agent", "focus", originalFocusedAgent.pane_id]);
    else if (originalFocusedTab) herdr(["tab", "focus", originalFocusedTab]);
  } catch {
    // The original pane or tab may have closed during a long recording.
  }
}

console.log(`Captured live Herdr parent/subagent frames and video in ${captureRoot}`);

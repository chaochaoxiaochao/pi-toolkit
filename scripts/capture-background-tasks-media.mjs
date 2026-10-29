#!/usr/bin/env node
// Record real Pi/Herdr UI in an owned workspace of an existing visible client. The offline provider only
// chooses tool calls; commands, output, widget hit-testing and tab cleanup are real.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = join(resolve(process.argv[2] ?? join(root, ".cache/package-media")), "background-herdr");
const windowId = process.env.HERDR_MEDIA_WINDOW_ID;
if (process.env.HERDR_ENV !== "1" || !windowId) throw new Error("Run inside Herdr with HERDR_MEDIA_WINDOW_ID set to the visible X11 Herdr client window.");
const env = { ...process.env };
const command = (binary, args, options = {}) => execFileSync(binary, args, { cwd: root, env, encoding: "utf8", timeout: 15_000, ...options });
function assertUnlocked() {
  const active = command("gdbus", ["call", "--session", "--dest", "org.gnome.ScreenSaver", "--object-path", "/org/gnome/ScreenSaver", "--method", "org.gnome.ScreenSaver.GetActive"]).trim();
  assert.equal(active, "(false,)", "Desktop is locked. Unlock it before recording; hidden windows can return stale pixels.");
}
assertUnlocked();
const work = mkdtempSync(join(tmpdir(), "pi-background-demo-"));
const herdr = (...args) => {
  const text = command("herdr", [...args]);
  return text.trim() ? JSON.parse(text).result : {};
};
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await pause(100);
  }
}
const events = () => existsSync(join(work, "events.jsonl")) ? readFileSync(join(work, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const tabs = (workspace) => herdr("tab", "list", "--workspace", workspace).tabs;
const panes = (workspace) => herdr("pane", "list", "--workspace", workspace).panes;
const visible = (pane) => command("herdr", ["pane", "read", pane, "--source", "visible"]);
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
let recorder, videoDone, parentPane, ownedWorkspace;
const originalWorkspace = herdr("workspace", "list").workspaces.find((workspace) => workspace.focused);
const checks = [];

mkdirSync(output, { recursive: true });
mkdirSync(join(work, "agent"));
writeFileSync(join(work, "agent/settings.json"), JSON.stringify({ quietStartup: true, theme: "dark" }));
copyFileSync(join(root, "packages/background-tasks/tests/fixtures/media-job.py"), join(work, "demo-job.py"));
const pi = process.env.PI_TEST_BINARY || "pi";
const args = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--offline",
  "-e", join(root, "packages/background-tasks/extensions/background-tasks.ts"),
  "-e", join(root, "packages/background-tasks/tests/fixtures/provider.ts"),
  "--tools", "background_task", "--model", "bg-fixture/deterministic", "--tui-mode", "fullscreen"];
writeFileSync(join(work, "run.sh"), `#!/bin/sh\ncd ${quote(work)}\nexport PI_CODING_AGENT_DIR=${quote(join(work, "agent"))} PI_OFFLINE=1 BG_SMOKE_EVENTS=${quote(join(work, "events.jsonl"))}\nunset PI_HERDR_SUBAGENTS_CHILD\nexec ${[pi, ...args].map(quote).join(" ")}\n`, { mode: 0o700 });
const capture = async (name) => {
  assertUnlocked();
  assert.match(command("xprop", ["-id", windowId, "WM_NAME"]), /Background Tasks demo/, "the visible client must show the demo workspace, not stale unrelated content");
  const image = join(output, `${name}.png`);
  command("import", ["-window", windowId, image]);
  const colours = Number(command("convert", [image, "-gravity", "center", "-crop", "80%x70%+0+0", "+repage", "-format", "%k", "info:"]));
  assert.ok(colours > 16, `Captured a blank client surface (${name}); check HERDR_MEDIA_WINDOW_ID`);
};
async function hold(seconds = 1.5) {
  await pause(seconds * 1000);
} // Viewing time in the published recording, not test readiness.
async function clickTask(workspace, parentTab, task, name) {
  herdr("tab", "focus", parentTab);
  await until(() => visible(parentPane).includes(task.id), "task row on screen");
  await hold();
  const lines = visible(parentPane).split("\n");
  const row = lines.findIndex((line) => line.includes(task.id) && line.includes("running") && !line.includes("Started")) + 1;
  assert.ok(row > 0, `No widget row for ${task.id}`);
  // Real fullscreen mouse input, not a direct /bg watch or focus command.
  herdr("pane", "send-text", parentPane, `\x1b[<0;8;${row}M\x1b[<0;8;${row}m`);
  const focused = await until(() => panes(workspace).find((pane) => pane.label?.startsWith(task.id) && pane.focused), `click focuses ${task.id}`);
  checks.push({ check: "widget-click", taskId: task.id, paneId: focused.pane_id, row });
  await until(() => visible(focused.pane_id).includes("demo-job.py"), "pane command header");
  await hold(2);
  await capture(name);
  return focused;
}
async function stopVideo() {
  if (!recorder) return;
  const active = recorder;
  recorder = undefined;
  active.kill("SIGINT");
  const exit = await videoDone;
  assert.equal(exit.code, 0, `screen recorder failed: ${JSON.stringify(exit)}`);
}

try {
  const created = herdr("workspace", "create", "--cwd", work, "--label", "Background Tasks demo", "--no-focus");
  ownedWorkspace = created.workspace.workspace_id;
  const workspaceId = ownedWorkspace;
  const parentTab = created.tab.tab_id;
  parentPane = created.root_pane.pane_id;
  herdr("tab", "rename", parentTab, "Parent Pi");
  herdr("workspace", "focus", workspaceId);
  herdr("pane", "run", parentPane, `sh ${quote(join(work, "run.sh"))}`);
  await until(() => events().some((event) => event.event === "loaded"), "real Pi extension startup");
  await until(() => visible(parentPane).includes("deterministic"), "fullscreen Pi painted");
  const log = openSync(join(output, "video.stderr"), "w");
  recorder = spawn("gst-launch-1.0", ["-e", "-q", "ximagesrc", `xid=${Number.parseInt(windowId, 16)}`, "use-damage=false", "show-pointer=false",
    "!", "video/x-raw,framerate=10/1", "!", "videoscale", "!", "video/x-raw,width=1280,height=728,pixel-aspect-ratio=1/1", "!", "videoconvert",
    "!", "vp8enc", "deadline=1", "cpu-used=8", "threads=4", "target-bitrate=1600000", "keyframe-max-dist=30",
    "!", "webmmux", "!", "filesink", `location=${join(output, "demo.webm")}`], { env, stdio: ["ignore", "ignore", log] });
  videoDone = new Promise((done) => {
    recorder.once("error", (error) => done({ error: error.message }));
    recorder.once("exit", (code, signal) => { closeSync(log); done({ code, signal }); });
  });
  await until(() => existsSync(join(output, "demo.webm")), "screen recorder output");
  await hold(1);
  herdr("pane", "send-text", parentPane, "Start two background demo jobs: build progress and a test suite. I want to watch both in Herdr.");
  await hold();
  herdr("pane", "send-keys", parentPane, "enter");
  const tasks = await until(() => {
    const starts = events().filter((event) => event.event === "tool_end" && event.name === "background_task" && event.result?.structuredContent?.action === "start");
    return starts.length === 2 && starts.map((event) => event.result.structuredContent.task);
  }, "two real accepted jobs");
  const taskTab = await until(() => tabs(workspaceId).find((tab) => tab.label === "Background tasks" && tab.pane_count === 2), "two task panes in one tab");
  assert.equal(taskTab.focused, false, "automatic creation must not steal focus");
  checks.push({ check: "unfocused-tab", panes: taskTab.pane_count });
  await until(() => visible(parentPane).includes("Both demo jobs are running"), "parent returned while jobs run");
  await hold(2);
  await capture("parent-widget");
  const build = await clickTask(workspaceId, parentTab, tasks[0], "build-focused");
  const before = visible(build.pane_id);
  await until(() => visible(build.pane_id) !== before, "real command output advances");
  const test = await clickTask(workspaceId, parentTab, tasks[1], "tests-focused");
  writeFileSync(join(work, "release-build"), "release");
  await until(() => visible(build.pane_id).includes("[succeeded · exit 0"), "build result line");
  checks.push({ check: "live-output-and-success", paneId: build.pane_id });
  await hold(2);
  await capture("build-completed");
  writeFileSync(join(work, "release-tests"), "release");
  await until(() => visible(test.pane_id).includes("[failed · exit 3"), "test result line");
  assert.ok(tabs(workspaceId).some((tab) => tab.tab_id === taskTab.tab_id), "focused completed tab must stay open");
  await hold(2);
  await capture("tasks-completed");
  herdr("tab", "focus", parentTab);
  await until(() => !tabs(workspaceId).some((tab) => tab.tab_id === taskTab.tab_id), "completed tab closes after user leaves");
  checks.push({ check: "focused-retention-and-cleanup" });
  await until(() => visible(parentPane).includes("Background jobs finished"), "automatic completion reaches parent");
  await hold(2);
  await capture("parent-final");
  await stopVideo();
  command("gst-discoverer-1.0", [join(output, "demo.webm")]);
  herdr("pane", "send-keys", parentPane, "ctrl+d");
  await until(() => tasks.every((task) => !existsSync(task.log_path)), "session log cleanup");
  assert.ok(!events().some((event) => JSON.stringify(event).includes("Herdr task view unavailable")));
  copyFileSync(join(work, "events.jsonl"), join(output, "events.jsonl"));
  writeFileSync(join(output, "result.json"), JSON.stringify({ passed: true, checks, model: "bg-fixture/deterministic", theme: "dark", workspaceId }, null, 2));
  console.log(`PASS real Background Tasks Herdr recording: ${checks.length} checks; ${output}`);
} catch (error) {
  writeFileSync(join(output, "error.txt"), error.stack ?? String(error));
  if (parentPane) {
    try { writeFileSync(join(output, "parent-error.txt"), visible(parentPane)); } catch { /* retain original error */ }
  }
  throw error;
} finally {
  try { await stopVideo(); }
  finally {
    if (ownedWorkspace) {
      try { herdr("workspace", "close", ownedWorkspace); } catch { /* already closed */ }
    }
    if (originalWorkspace) {
      herdr("workspace", "focus", originalWorkspace.workspace_id);
      if (originalWorkspace.active_tab_id) herdr("tab", "focus", originalWorkspace.active_tab_id);
    }
    rmSync(work, { recursive: true, force: true });
  }
}

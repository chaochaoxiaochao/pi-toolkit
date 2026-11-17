#!/usr/bin/env node
// Real Pi PTY rendered by xterm.js in Chrome. CDP clicks exercise native TUI hit-testing.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = join(resolve(process.argv[2] ?? join(root, ".cache/package-media")), "background-terminal");
const withEditor = process.env.BG_MEDIA_EDITOR !== "none";
const xterm = process.env.XTERM_DIR ?? join(homedir(), ".pi/agent/npm/node_modules/@xterm/xterm");
for (const file of ["lib/xterm.js", "css/xterm.css"]) assert.ok(existsSync(join(xterm, file)), `Set XTERM_DIR to an installed @xterm/xterm package (${file})`);
const work = mkdtempSync(join(tmpdir(), "pi-background-demo-"));
const token = randomUUID();
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await pause(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}
const events = () => existsSync(join(work, "events.jsonl")) ? readFileSync(join(work, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const starts = () => events().filter((e) => e.event === "tool_end" && e.result?.structuredContent?.action === "start").map((e) => e.result.structuredContent.task);
const free = netServer();
await new Promise((done) => free.listen(0, "127.0.0.1", done));
const debugPort = free.address().port;
await new Promise((done) => free.close(done));
const html = `<!doctype html><meta charset="utf-8"><title>Background Tasks — real Pi terminal</title>
<link rel="stylesheet" href="/${token}/xterm.css"><style>html,body{margin:0;background:#0d1117}#terminal{padding:16px}</style>
<div id="terminal" aria-label="Real Pi terminal"></div><script src="/${token}/xterm.js"></script><script>
const term = window.term = new Terminal({cols:130,rows:36,fontSize:14,fontFamily:'DejaVu Sans Mono,monospace',theme:{background:'#0d1117'},scrollback:1000});
term.open(document.getElementById('terminal')); term.focus();
const socket = new WebSocket('ws://'+location.host+'/${token}/pty');
term.onData(input=>socket.send(JSON.stringify({input})));
socket.onmessage=e=>term.write(Uint8Array.from(atob(e.data),c=>c.charCodeAt(0)));
window.screenLines=()=>Array.from({length:term.rows},(_,i)=>term.buffer.active.getLine(term.buffer.active.viewportY+i)?.translateToString(true)||'');
</script>`;
const server = createServer((req, res) => {
  const files = { [`/${token}/xterm.js`]: ["lib/xterm.js", "text/javascript"], [`/${token}/xterm.css`]: ["css/xterm.css", "text/css"] };
  const file = files[req.url];
  if (req.url === `/${token}/`) { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); }
  else if (file) { res.setHeader("Content-Type", file[1]); res.end(readFileSync(join(xterm, file[0]))); }
  else { res.writeHead(404); res.end(); }
});
const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url !== `/${token}/pty` || req.headers.origin !== `http://127.0.0.1:${server.address().port}`) return socket.destroy();
  sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws));
});
let terminal, cdp, browser;
const frames = [];
const checks = [];
try {
  mkdirSync(output, { recursive: true });
  mkdirSync(join(work, "agent"));
  writeFileSync(join(work, "agent/settings.json"), JSON.stringify({ quietStartup: true, theme: "dark" }));
  copyFileSync(join(root, "packages/background-tasks/tests/fixtures/media-job.py"), join(work, "demo-job.py"));
  sockets.on("connection", (socket) => {
    assert.equal(terminal, undefined, "only one terminal client per recording");
    const args = [process.env.PI_TEST_BINARY || "pi", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "--offline",
      "-e", join(root, "packages/background-tasks/extensions/background-tasks.ts"),
      ...(withEditor ? ["-e", join(root, "packages/codex-edit/extensions/codex-edit.ts")] : []),
      "-e", join(root, "packages/background-tasks/tests/fixtures/provider.ts"),
      "--tools", withEditor ? "background_task,edit" : "background_task", "--model", "bg-fixture/deterministic", "--tui-mode", "fullscreen"];
    terminal = spawn("python3", [join(root, "packages/background-tasks/tests/fixtures/terminal.py"), ...args], {
      cwd: work, env: { ...process.env, PI_CODING_AGENT_DIR: join(work, "agent"), PI_OFFLINE: "1", BG_SMOKE_EVENTS: join(work, "events.jsonl"), TERM: "xterm-256color", COLORTERM: "truecolor" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    createInterface({ input: terminal.stdout }).on("line", (line) => { if (socket.readyState === 1) socket.send(JSON.parse(line).output); });
    socket.on("message", (data) => terminal.stdin.write(data + "\n"));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  // Use the browser skill's documented launcher, with an isolated endpoint.
  execFileSync("node", [join(root, "skills/web-browser/scripts/start.js"), "--headless"], {
    env: { ...process.env, HOME: join(work, "browser-home"), BROWSER_DEBUG_PORT: String(debugPort) }, stdio: "pipe", timeout: 30000,
  });
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  browser = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((done, reject) => { browser.onopen = done; browser.onerror = reject; });
  let next = 0;
  const pending = new Map();
  browser.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    pending.delete(message.id); clearTimeout(timer);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  };
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    browser.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const screen = () => evaluate("screenLines()");
  const waitText = (text) => until(async () => (await screen()).some((line) => line.includes(text)), text);
  const assertCleanPanel = async () => {
    const lines = await screen();
    assert.ok(!lines.some((line) => /editor: edit|%\/128k|\(auto\)|bg-fixture\)/.test(line)), "panel hides the native footer, model, usage and extension statuses");
    assert.ok(!lines.some((line) => line.includes(work)), "panel hides the working-directory footer");
  };
  const assertBottomCount = async (label) => {
    const lines = await screen();
    const bottom = lines.findLastIndex((line) => line.trim());
    assert.match(lines[bottom], new RegExp(`^${withEditor ? "editor: edit · " : ""}${label} · Alt\\+J`), "clickable shell count is on the bottom status row, beside the editor when loaded");
    assert.equal(lines.filter((line) => line.includes(`${label} · Alt+J`)).length, 1, "no duplicate below-editor counter");
  };
  const key = async (name, extra = {}) => {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: name, ...extra });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: name, ...extra });
    await pause(200); // Let terminal Escape decoding and editor focus settle before the next input.
  };
  const prompt = async (text) => { await cdp("Input.insertText", { text }); await key("Enter", { windowsVirtualKeyCode: 13 }); };
  const clickText = async (text) => {
    const lines = await screen();
    const row = lines.findLastIndex((line) => line.includes(text));
    assert.ok(row >= 0, `missing click target: ${text}`);
    const col = lines[row].indexOf(text) + 2;
    const rect = await evaluate("(()=>{const r=document.querySelector('.xterm-screen').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
    const point = { x: rect.x + (col + 0.5) * rect.width / 130, y: rect.y + (row + 0.5) * rect.height / 36, button: "left", clickCount: 1 };
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
  };
  const shot = async (name) => {
    await pause(250);
    const image = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(output, `${name}.png`), Buffer.from(image.data, "base64"));
    writeFileSync(join(output, `${name}.txt`), (await screen()).join("\n"));
    frames.push(name);
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1140, height: 650, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/${token}/` });
  await until(() => events().some((e) => e.event === "loaded"), "Pi startup");
  await waitText("deterministic");
  assert.ok(!(await screen()).some((line) => /Extension issues|shortcut conflict/.test(line)));
  assert.ok(!events().find((e) => e.event === "loaded").commands.includes("bg"));
  await prompt("Start one background demo job: build progress.");
  await until(() => starts().length === 1, "first shell");
  await waitText("1 shell");
  await assertBottomCount("1 shell");
  checks.push(withEditor ? "bottom shell count shares the native editor status row" : "bottom shell count works without an editor extension");
  await shot("single-count");
  await clickText("1 shell");
  await waitText("Shell details");
  await waitText("Compiling module");
  await assertCleanPanel();
  const aligned = (await screen()).filter((line) => /^\s*(Status|Runtime|Command):/.test(line));
  assert.equal(aligned.length, 3);
  assert.ok(aligned.every((line) => line.indexOf(":") < 12 && line.slice(12).trim()), "detail values start at column 12");
  assert.match(aligned.find((line) => line.includes("Command:")), /Command:  set -e export BG_DEMO=1 export CI=1 python3 demo-job\.py build$/);
  checks.push("four-line script is previewed continuously, keeping the actual command visible after exports");
  await shot("single-details");
  checks.push("real count click opens single-shell details and aligned fields");
  await key("Escape", { windowsVirtualKeyCode: 27 });
  await assertBottomCount("1 shell");
  checks.push("panel hides the entire native footer and closing restores it");
  await prompt("Start the second background demo job: a test suite.");
  await until(() => starts().length === 2, "second shell");
  await waitText("2 shells");
  await assertBottomCount("2 shells");
  await shot("two-count");
  await clickText("2 shells");
  await waitText("2 active shells");
  await assertCleanPanel();
  await shot("shell-list");
  await key("ArrowDown", { windowsVirtualKeyCode: 40 });
  await key("Enter", { windowsVirtualKeyCode: 13 });
  await waitText("test_001");
  await assertCleanPanel();
  await shot("tests-details");
  checks.push("two shells open list; Down and Enter select second shell");
  await key("ArrowLeft", { windowsVirtualKeyCode: 37 });
  await waitText("2 active shells");
  await clickText("python3 demo-job.py build");
  await waitText("Shell details");
  await waitText("Compiling module");
  await shot("build-details");
  writeFileSync(join(work, "release-build"), "release");
  await waitText("succeeded");
  await shot("build-completed");
  checks.push("list row click selects build; real output and completion refresh in place");
  await key("ArrowLeft", { windowsVirtualKeyCode: 37 });
  await waitText("1 active shell");
  await clickText("python3 demo-job.py tests");
  await waitText("Shell details");
  await cdp("Input.insertText", { text: "x" });
  await waitText("cancelled");
  await shot("tests-cancelled");
  checks.push("x cancels the selected native process without a model call");
  await key("Escape", { windowsVirtualKeyCode: 27 });
  await until(async () => !(await screen()).some((line) => /\d+ shells? ·.*Alt\+J/.test(line)), "count expires");
  if (withEditor) await waitText("editor: edit");
  await key("j", { code: "KeyJ", windowsVirtualKeyCode: 74, modifiers: 1 });
  await waitText("Earlier in this session (2)");
  await assertCleanPanel();
  await shot("history");
  checks.push("Alt+J reopens finished history after count expires");
  await key("Escape", { windowsVirtualKeyCode: 27 });
  await key("d", { windowsVirtualKeyCode: 68, modifiers: 2 });
  await until(() => starts().every((task) => !existsSync(task.log_path)), "session log cleanup");
  writeFileSync(join(output, "result.json"), JSON.stringify({ passed: true, checks, frames, model: "bg-fixture/deterministic", terminal: "real Pi PTY in xterm.js / Chrome" }, null, 2));
  copyFileSync(join(work, "events.jsonl"), join(output, "events.jsonl"));
  console.log(`PASS Background Tasks browser/TUI flow: ${checks.length} checks; ${output}`);
} catch (error) {
  writeFileSync(join(output, "error.txt"), error.stack ?? String(error));
  if (cdp) {
    try { writeFileSync(join(output, "error.png"), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64")); } catch { /* Keep original error. */ }
  }
  throw error;
} finally {
  if (terminal) {
    terminal.stdin.end();
    await until(() => terminal.exitCode !== null, "PTY shutdown", 15000);
  }
  if (cdp) await cdp("Browser.close").catch(() => {});
  browser?.close();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  await new Promise((done) => server.close(done));
  rmSync(work, { recursive: true, force: true });
}

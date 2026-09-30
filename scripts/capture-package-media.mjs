#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const captureDir = join(root, ".cache", "package-media");
rmSync(captureDir, { recursive: true, force: true });
mkdirSync(captureDir, { recursive: true });
const pages = (name, values) => writeFileSync(join(captureDir, `${name}.json`), JSON.stringify(values, null, 2));

function freePort() {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForEndpoint(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch { /* Chrome is still starting. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Chrome did not expose its debugging endpoint on port ${port}`);
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error("CDP connection timed out")), 5_000);
    socket.onopen = () => { clearTimeout(timer); resolveOpen(); };
    socket.onerror = () => { clearTimeout(timer); rejectOpen(new Error("CDP connection failed")); };
  });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve: resolveRequest, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolveRequest(message.result);
  };
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolveRequest, reject) => {
        pending.set(id, { resolve: resolveRequest, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function captureFullPage(chrome, url, output) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "cache-media-chrome-"));
  const process = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--window-size=1440,1000", "about:blank",
  ], { stdio: "ignore" });
  let cdp;
  try {
    await waitForEndpoint(port);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("Chrome did not create a page target");
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send("Page.navigate", { url });
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await cdp.send("Runtime.evaluate", {
        expression: `document.readyState === "complete" && !!document.querySelector(".usage-chart")`,
        returnByValue: true,
      });
      if (result.result.value) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const content = metrics.cssContentSize || metrics.contentSize;
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: Math.max(1, Math.ceil(content.width)),
        height: Math.max(1, Math.ceil(content.height)),
        scale: 1,
      },
    });
    writeFileSync(output, Buffer.from(screenshot.data, "base64"));
  } finally {
    cdp?.close();
    process.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  }
}

function table(state) {
  return state.todos.map((todo) => `${String(todo.id).padStart(2)}  ${todo.status.padEnd(9)} ${todo.text}`).join("\n");
}

// Todo: execute the production state machine and capture each mutation.
{
  const { applyTodoAction } = await import(join(root, "packages/todo/src/todo-state.ts"));
  let state = { todos: [], nextId: 1 };
  state = applyTodoAction(state, { action: "replace", items: ["Inspect the failure", "Implement the fix", "Run verification"] });
  const first = [`$ todo replace`, table(state), ``, `One active task; stable IDs start at 1.`].join("\n");
  state = applyTodoAction(state, { action: "update", id: 1, status: "done" });
  const second = [first, ``, `$ todo update 1 done`, table(state), ``, `Completing #1 automatically advances #2.`].join("\n");
  state = applyTodoAction(state, { action: "update", id: 2, status: "done" });
  const third = [second, ``, `$ todo update 2 done`, table(state), ``, `Closed work remains in history; #3 is now active.`].join("\n");
  pages("todo", [first, second, third]);
}

// Codex Edit: parse and apply a real Codex patch against a temporary fixture.
{
  const { applyUpdate, parsePatch } = await import(join(root, "packages/codex-edit/src/parser.ts"));
  const before = `---\nname: demo\ndescription: old\n---\n\n# Demo\n\n---\nFooter\n`;
  const patch = `*** Begin Patch\n*** Update File: SKILL.md\n@@\n-description: old\n+description: cache diagnostics\n@@\n ---\n+Generated by apply_patch.\n*** End Patch`;
  const operation = parsePatch(patch)[0];
  const after = applyUpdate(before, operation.chunks, operation.path);
  const one = [`$ apply_patch <<'PATCH'`, patch, `PATCH`].join("\n");
  const two = [one, ``, `Parsed 1 update with 2 hunks.`, `Matched the first separator after the hunk cursor.`].join("\n");
  const changed = after.split("\n").map((line, i) => {
    const old = before.split("\n")[i];
    return line === old ? `  ${line}` : `+ ${line}`;
  }).join("\n");
  const three = [two, ``, `Applied SKILL.md:`, changed, ``, `Result: patch applied successfully.`].join("\n");
  pages("codex-edit", [one, two, three]);
}

// Tiny Subagent: run the production runner through a real isolated child process.
{
  const { runTinySubagent } = await import(join(root, "packages/tiny-subagent/src/runner.ts"));
  const temp = mkdtempSync(join(tmpdir(), "tiny-media-"));
  try {
    const child = join(temp, "child.mjs");
    const capture = join(temp, "launch.json");
    writeFileSync(child, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.TINY_MEDIA_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), child: process.env.PI_SUBAGENT_CHILD }));
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "fixture/reviewer", stopReason: "stop", content: [{ type: "text", text: "Found one issue: validate the empty path before writing." }] } }) + "\\n");
`, { mode: 0o700 });
    chmodSync(child, 0o700);
    const previous = { binary: process.env.PI_TINY_SUBAGENT_PI_BINARY, capture: process.env.TINY_MEDIA_CAPTURE };
    process.env.PI_TINY_SUBAGENT_PI_BINARY = child;
    process.env.TINY_MEDIA_CAPTURE = capture;
    const result = await runTinySubagent("Review src/export.ts", { cwd: temp, model: "fixture/reviewer", tools: ["read", "grep"] });
    const launch = JSON.parse(readFileSync(capture, "utf8"));
    if (previous.binary === undefined) delete process.env.PI_TINY_SUBAGENT_PI_BINARY; else process.env.PI_TINY_SUBAGENT_PI_BINARY = previous.binary;
    if (previous.capture === undefined) delete process.env.TINY_MEDIA_CAPTURE; else process.env.TINY_MEDIA_CAPTURE = previous.capture;
    const one = [`$ tiny_subagents run reviewer "Review src/export.ts"`, ``, `Launching isolated child process...`].join("\n");
    const two = [one, `  model: fixture/reviewer`, `  tools: read, grep`, `  session: ${launch.args.includes("--no-session") ? "fresh (--no-session)" : "unexpected"}`, `  extension discovery: ${launch.args.includes("--no-extensions") ? "disabled" : "enabled"}`, `  child marker: ${launch.child}`].join("\n");
    const three = [two, ``, `Child result`, `------------`, result.output, ``, `Process exited successfully.`].join("\n");
    pages("tiny-subagent", [one, two, three]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// Worktree: run the shipped CLI against a real temporary Git repository.
{
  const temp = mkdtempSync(join(tmpdir(), "worktree-media-"));
  try {
    const repo = join(temp, "demo");
    const bin = join(temp, "bin");
    mkdirSync(repo); mkdirSync(bin);
    writeFileSync(join(bin, "pi"), "#!/bin/sh\nprintf 'Pi launched in: %s\\n' \"$PWD\"\nprintf 'Pi args: %s\\n' \"$*\"\n", { mode: 0o700 });
    chmodSync(join(bin, "pi"), 0o700);
    const run = (command, args = []) => execFileSync(command, args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    }).trim();
    run("git", ["init", "-q", "-b", "main"]);
    run("git", ["config", "user.email", "media@example.com"]); run("git", ["config", "user.name", "Media"]);
    writeFileSync(join(repo, ".gitignore"), ".worktrees/\n"); writeFileSync(join(repo, "app.txt"), "base\n");
    run("git", ["add", "."]); run("git", ["commit", "-qm", "initial"]);
    const cli = join(root, "packages/worktree/bin/pi-worktree");
    const start = run("bash", [cli, "start", "cache-report", "--model", "fixture/model"]);
    const one = [`$ pi-worktree start cache-report --model fixture/model`, start.replaceAll(temp, "/tmp/pi-worktree-demo")].join("\n");
    const list = run("bash", [cli, "list"]);
    const two = [one, ``, `$ pi-worktree list`, list.replaceAll(temp, "/tmp/pi-worktree-demo")].join("\n");
    const info = run("bash", [cli, "info", "cache-report"]);
    const three = [two, ``, `$ pi-worktree info cache-report`, info.replaceAll(temp, "/tmp/pi-worktree-demo")].join("\n");
    pages("worktree", [one, two, three]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// Cache Export: build the actual self-contained dashboard, then capture real browser states.
{
  const { buildCacheExportHtml, parseEntries } = await import(join(root, "packages/cache-export/src/render.ts"));
  const entries = [];
  for (let i = 1; i <= 45; i++) {
    if (i === 25) entries.push({ type: "model_change", timestamp: "2026-02-01T00:24:30Z", provider: "openai", modelId: "gpt-5.2-codex" });
    if (i === 25 || i === 40) entries.push({ type: "compaction", timestamp: `2026-02-01T00:${String(i - 1).padStart(2, "0")}:45Z` });
    entries.push({ type: "message", timestamp: `2026-02-01T00:${String(i).padStart(2, "0")}:00Z`, message: { role: "assistant", provider: "openai", model: i < 25 ? "gpt-5.1-codex" : "gpt-5.2-codex", api: "openai-responses", stopReason: "stop", content: [], usage: { input: 1800 + i * 47, cacheRead: i % 7 === 0 ? 2400 : 72000 + i * 610, cacheWrite: 0, output: 180 + i * 4 } } });
  }
  const html = buildCacheExportHtml(parseEntries(entries), { title: "Pi cache diagnostics — real export", sessionId: "media-capture" });
  const variants = [
    ["cache-latest", ""],
    ["cache-all", `<script>addEventListener('load',()=>{const s=document.querySelector('[data-context-segment-select]');s.value='all';s.dispatchEvent(new Event('change'));});</script>`],
    ["cache-tooltip", `<script>addEventListener('load',()=>setTimeout(()=>{const s=document.querySelector('[data-context-segment-select]');s.value='all';s.dispatchEvent(new Event('change'));const c=[...document.querySelectorAll('svg.usage-chart')].find(x=>x.getAttribute('aria-label')==='Prompt input by request'&&!x.closest('.usage-context-view').hidden);const r=c.getBoundingClientRect();c.dispatchEvent(new PointerEvent('pointermove',{clientX:r.left+r.width*.82,clientY:r.top+r.height/2,bubbles:true}));},100));</script>`],
  ];
  const chrome = [process.env.BROWSER_BIN, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((candidate) => candidate && existsSync(candidate));
  if (!chrome) throw new Error("Chrome/Chromium is required to capture Cache Export media");
  for (const [name, injection] of variants) {
    const path = join(captureDir, `${name}.html`);
    writeFileSync(path, html.replace("</body>", `${injection}</body>`));
    await captureFullPage(chrome, `file://${path}`, join(captureDir, `${name}.png`));
  }
}

execFileSync("python3", [join(root, "scripts/render-package-media.py"), captureDir], { stdio: "inherit" });
console.log(`Captured and rendered real package media from ${captureDir}`);

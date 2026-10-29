#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Optional package slugs limit the run, e.g. `node scripts/capture-package-media.mjs scheduler`.
const selected = new Set(process.argv.slice(2));
const wanted = (slug) => selected.size === 0 || selected.has(slug);
const captureDir = join(root, ".cache", "package-media");
rmSync(captureDir, { recursive: true, force: true });
mkdirSync(captureDir, { recursive: true });
const pages = (name, values) => writeFileSync(join(captureDir, `${name}.json`), JSON.stringify(values, null, 2));

// Background Tasks: drive the real Pi TUI with an offline provider, then capture its window.
if (wanted("background-tasks")) {
  const output = join(captureDir, "background-live");
  execFileSync("gnome-terminal.real", [
    "--wait", "--window", "--title=Pi Background Tasks Smoke", "--geometry=140x42", "--",
    "env", "BG_SMOKE_RENDER=1", "BG_SMOKE_CAPTURE=1", "python3",
    join(root, "packages/background-tasks/tests/tui-smoke.py"), output,
  ], { cwd: root, stdio: "inherit", timeout: 90_000 });
  const result = JSON.parse(readFileSync(join(output, "result.json"), "utf8"));
  if (result.passed !== true) throw new Error("Background Tasks real-TUI capture did not pass");
  execFileSync(process.execPath, [join(root, "scripts/capture-background-tasks-media.mjs"), captureDir], {
    cwd: root, stdio: "inherit", timeout: 120_000,
  });
}

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

// Scheduler: execute the production scheduler with a deterministic clock.
if (wanted("scheduler")) {
  const { Scheduler } = await import(join(root, "packages/scheduler/src/scheduler.ts"));
  class MediaClock {
    nowMs = Date.UTC(2026, 9, 9, 9, 0, 0);
    nextHandle = 1;
    timers = new Map();
    now() { return this.nowMs; }
    setTimeout(callback, delayMs) {
      const handle = this.nextHandle++;
      this.timers.set(handle, { at: this.nowMs + delayMs, callback });
      return handle;
    }
    clearTimeout(handle) { this.timers.delete(handle); }
    advance(ms) {
      this.nowMs += ms;
      for (;;) {
        const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.nowMs).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) return;
        this.timers.delete(due[0]);
        due[1].callback();
      }
    }
  }
  const clock = new MediaClock();
  const scheduler = new Scheduler({ clock, onTrigger() {} });
  const created = scheduler.add("5m", "Check CI; report completion or failure.");
  const one = [
    `$ /schedule add 5m Check CI; report completion or failure.`,
    `Created ${created.id} · next 09:05:00`,
    ``,
    `TUI widget above editor (Herdr Fleet stays below)`,
    `⏱ 1 active schedule`,
    `  ○ ${created.id} · 5m · next 09:05:00 · Check CI; report completion or failure.`,
  ].join("\n");
  const second = scheduler.add("15m", "Check deployment health.");
  const two = [one, ``, `$ /schedule add 15m Check deployment health.`, `Created ${second.id} · next 09:15:00`, ``, `TUI widget above editor (Herdr Fleet stays below)`, `⏱ 2 active schedules`, `  ○ ${created.id} · 5m · next 09:05:00 · Check CI; report completion or failure.`, `  ○ ${second.id} · 15m · next 09:15:00 · Check deployment health.`].join("\n");
  const cleared = scheduler.clear();
  const replacement = scheduler.add("10m", "Check release status.");
  const three = [two, ``, `$ /schedule clear`, `Cleared ${cleared} schedules.`, ``, `$ /schedule add 10m Check release status.`, `Created ${replacement.id} · next 09:10:00`, ``, `TUI widget above editor (Herdr Fleet stays below)`, `⏱ 1 active schedule`, `  ○ ${replacement.id} · 10m · next 09:10:00 · Check release status.`].join("\n");
  pages("scheduler", [one, two, three]);
}

// Todo: execute the production state machine and capture each mutation.
if (wanted("todo")) {
  const { applyTodoAction } = await import(join(root, "packages/todo/src/todo-state.ts"));
  let state = { todos: [], nextId: 1 };
  state = applyTodoAction(state, { action: "plan", items: ["Inspect the failure", "Implement the fix", "Run verification"] });
  const first = [`$ todo plan`, table(state), ``, `One current step; stable IDs start at 1.`].join("\n");
  state = applyTodoAction(state, { action: "complete_current", expected_current_id: 1 });
  const second = [first, ``, `$ todo complete_current 1`, table(state), ``, `Completing #1 advances exactly one step.`].join("\n");
  state = applyTodoAction(state, { action: "plan", items: ["Investigate new direction", "Verify new direction"] });
  const third = [second, ``, `$ todo plan  # changed direction`, table(state), ``, `Replanning preserves closed history and cancels old unfinished work.`].join("\n");
  pages("todo", [first, second, third]);
}

// Codex Edit: parse and apply a real Codex patch against a temporary fixture.
if (wanted("codex-edit")) {
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

// Herdr Subagents: record a parent Pi conversation and three real Agent panes.
if (wanted("herdr-subagents")) {
  execFileSync(process.execPath, [join(root, "scripts/capture-herdr-subagents-media.mjs"), captureDir], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
}

// Worktree: run the shipped CLI against a real temporary Git repository.
if (wanted("worktree")) {
  const temp = mkdtempSync(join(tmpdir(), "worktree-media-"));
  try {
    const repo = join(temp, "demo");
    mkdirSync(repo);
    const run = (command, args = []) => execFileSync(command, args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    }).trim();
    run("git", ["init", "-q", "-b", "main"]);
    run("git", ["config", "user.email", "media@example.com"]); run("git", ["config", "user.name", "Media"]);
    writeFileSync(join(repo, ".gitignore"), ".worktrees/\n"); writeFileSync(join(repo, "app.txt"), "base\n");
    run("git", ["add", "."]); run("git", ["commit", "-qm", "initial"]);
    const cli = join(root, "packages/worktree/bin/pi-worktree");
    const create = run("bash", [cli, "create", "cache-report"]);
    const one = [`$ pi-worktree create cache-report`, create.replaceAll(temp, "/tmp/pi-worktree-demo")].join("\n");
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
if (wanted("cache-export")) {
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

// OpenAI Account Pool: run the real wizard, status and failover wrapper over a temporary agent dir.
if (wanted("openai-account-pool")) {
  const pkg = join(root, "packages/openai-account-pool");
  const { confirmText, poolStatus, runEnrollment } = await import(join(pkg, "src/enrollment.ts"));
  const { loadPoolSnapshot, POOL_UNRESOLVED_API_KEY } = await import(join(pkg, "src/auth.ts"));
  const { createPoolProvider } = await import(join(pkg, "src/provider.ts"));
  const { poolStatePathFor } = await import(join(pkg, "src/store.ts"));
  const { fakeCredential } = await import(join(pkg, "tests/helpers/fixtures.mjs"));
  const { piAiEntry } = await import(join(pkg, "tests/helpers/pi-runtime.mjs"));
  const { createAssistantMessageEventStream, lazyStream } = await import(piAiEntry());

  const agentDir = mkdtempSync(join(tmpdir(), "openai-account-pool-media-"));
  try {
    const authPath = join(agentDir, "auth.json");
    const statePath = poolStatePathFor(agentDir);
    // Demo credentials only: these ids and tokens exist nowhere but this temporary directory.
    const accounts = ["demo-account-7f3a", "demo-account-4c91"];
    const transcript = [];
    const scripted = (steps) => ({
      confirm: async (view) => {
        const step = steps.shift();
        transcript.push(`$ /codex_pool`, confirmText(view), step === "continue" ? "  \u2192 \u7ee7\u7eed\uff1a\u767b\u5f55\u5e76\u6dfb\u52a0\u4e00\u4e2a\u8d26\u53f7" : "  \u2192 \u7ed3\u675f\uff1a\u4fdd\u7559\u8d26\u53f7\u6c60\u548c\u81ea\u52a8\u5207\u6362");
        return step ?? "end";
      },
      login: async () => fakeCredential(accounts.shift()),
      notify: (message) => transcript.push(message),
    });

    await runEnrollment({ authPath, statePath, ui: scripted(["continue", "end"]) });
    const one = transcript.join("\n");

    transcript.length = 0;
    await runEnrollment({ authPath, statePath, ui: scripted(["continue", "end"]) });
    const added = transcript.join("\n");

    const statusLines = async () => {
      const status = await poolStatus({ authPath, statePath });
      return [`$ /codex_pool status`, status.summary, ...status.accounts.map((account) => `${account.label} ${account.detail}`)].join("\n");
    };
    const two = [one, ``, added, ``, await statusLines()].join("\n");

    // A real request through the wrapper: the first account reports a subscription limit.
    const limited = { shift: true };
    const message = (text) => ({ role: "assistant", content: text ? [{ type: "text", text }] : [], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5-codex", usage: { input: 812, output: 96, cacheRead: 0, cacheWrite: 0, totalTokens: 908, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: new Date().toISOString() });
    const codex = {
      id: "openai-codex",
      name: "OpenAI Codex",
      baseUrl: "https://chatgpt.com/backend-api",
      auth: { oauth: { name: "OpenAI (ChatGPT Plus/Pro)", isSubscription: true, login: async () => { throw new Error("unused"); }, refresh: async (credential) => credential, toAuth: async (credential) => ({ apiKey: credential.access }) } },
      getModels: () => [],
      stream: (model, context, options) => {
        const stream = createAssistantMessageEventStream();
        (async () => {
          const response = await options.fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST" });
          if (!response.ok) {
            stream.push({ type: "error", reason: "error", error: { ...message(), stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit." } });
            return;
          }
          const partial = message("Patch applied to src/cache.ts.");
          stream.push({ type: "start", partial });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "Patch applied to src/cache.ts.", partial });
          stream.push({ type: "done", reason: "stop", message: partial });
        })();
        return stream;
      },
      streamSimple: (model, context, options) => codex.stream(model, context, options),
    };
    const notes = [];
    const provider = createPoolProvider(codex, { lazyStream, authPath, statePath, notify: (note) => notes.push(note) });
    const model = { id: "gpt-5-codex", name: "GPT-5 Codex", api: "openai-codex-responses", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api/codex", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const events = [];
    for await (const event of provider.stream(model, { messages: [] }, {
      apiKey: POOL_UNRESOLVED_API_KEY,
      fetch: async () => {
        if (!limited.shift) return new Response("{}", { status: 200 });
        limited.shift = false;
        return new Response(JSON.stringify({ error: { code: "usage_limit_reached", plan_type: "plus", resets_at: Math.floor(Date.now() / 1000) + 3600 } }), { status: 429, headers: { "content-type": "application/json" } });
      },
    })) events.push(event);

    const three = [
      two,
      ``,
      `$ \u8bf7\u6c42 gpt-5-codex\uff08\u7b2c\u4e00\u4e2a\u8d26\u53f7\u989d\u5ea6\u8017\u5c3d\uff09`,
      ...notes,
      `\u5bf9\u8bdd\u53ea\u770b\u5230\u4e00\u4e2a\u56de\u7b54\uff1a${events.map((event) => event.type).join(" \u2192 ")}`,
      events.at(-1).message.content[0].text,
      ``,
      await statusLines(),
    ].join("\n");

    pages("openai-account-pool", [one, two, three]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

execFileSync("python3", [join(root, "scripts/render-package-media.py"), captureDir, ...selected], { stdio: "inherit" });
console.log(`Captured and rendered real package media from ${captureDir}`);

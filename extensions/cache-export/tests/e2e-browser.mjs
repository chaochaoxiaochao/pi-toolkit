// Real-browser end-to-end test for the cache dashboard.
// Drives actual pointer events in headless Chromium via raw CDP (Node 22
// built-ins only: fetch + WebSocket) and asserts the hover tooltip keeps
// working across polyline break boundaries and inside segment views.
//
// Chrome discovery mirrors the web-browser skill (BROWSER_BIN, common Linux
// paths, Playwright cache, WSL Windows Chrome). If no browser is found the
// test prints SKIP and exits 0 so CI without Chrome still passes; if a
// browser IS found, failing assertions exit 1.
//
// Run: node tests/e2e-browser.mjs        (from extensions/cache-export)

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEntries, buildCacheExportHtml } from "../render.ts";

let pass = 0, fail = 0, skipped = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

// --- Chrome discovery (mirrors the web-browser skill) ---------------------

const IS_WSL = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

function commandOutput(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function findChrome() {
  if (process.env.BROWSER_BIN && existsSync(process.env.BROWSER_BIN)) return process.env.BROWSER_BIN;
  // Prefer Linux binaries (also run fine under WSL2 and CI). Windows Chrome is
  // a last resort: its launch interacts with any already-running Chrome
  // singleton and can silently skip binding the debugging port.
  const candidates = [
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  // Playwright-managed Chromium builds
  const pwRoot = join(process.env.HOME || tmpdir(), ".cache", "ms-playwright");
  if (existsSync(pwRoot)) {
    for (const dir of readdirSync(pwRoot)) {
      const p = join(pwRoot, dir, "chrome-linux", "chrome");
      if (existsSync(p)) return p;
    }
  }
  for (const p of [
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ]) if (existsSync(p)) return p;
  return null;
}

// --- tiny CDP client ------------------------------------------------------

async function cdpConnect(wsUrl, timeoutMs = 5000) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws connect timeout")), timeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws connect error")); };
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { ws.close(); },
  };
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForEndpoint(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (resp.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// --- fixture --------------------------------------------------------------

function entry(i, model) {
  const mm = String(i % 60).padStart(2, "0");
  const ss = String(Math.floor(i / 60)).padStart(2, "0");
  return {
    type: "message",
    timestamp: `2026-02-01T00:${mm}:${ss}Z`,
    message: {
      role: "assistant", provider: "p", model, api: "openai-responses",
      stopReason: "stop", content: [],
      usage: { input: 2000, cacheRead: i % 7 === 0 ? 3000 : 90000, cacheWrite: 0, output: 200 },
    },
  };
}

function fixtureEntries() {
  const entries = [];
  for (let i = 1; i <= 24; i++) entries.push(entry(i, "m1"));
  entries.push({ type: "model_change", timestamp: "2026-02-01T00:24:30Z", provider: "p", modelId: "m2" });
  entries.push({ type: "compaction", timestamp: "2026-02-01T00:24:45Z" });
  for (let i = 25; i <= 32; i++) entries.push(entry(i, "m2"));
  entries.push({ type: "model_change", timestamp: "2026-02-01T00:32:30Z", provider: "p", modelId: "m3" });
  for (let i = 33; i <= 39; i++) entries.push(entry(i, "m3"));
  entries.push({ type: "compaction", timestamp: "2026-02-01T00:39:30Z" });
  for (let i = 40; i <= 45; i++) entries.push(entry(i, "m3"));
  return entries;
}

const HOVER_SCRIPT = `
  (() => {
    window.__errs = [];
    window.addEventListener("error", (e) => __errs.push(String(e.message)));
    const sel = document.querySelector("[data-context-segment-select]");
    function setView(value) {
      sel.value = value; sel.dispatchEvent(new Event("change"));
    }
    function hover(label, frac) {
      // Only the chart inside the currently visible context view can be hovered.
      const chart = [...document.querySelectorAll("svg.usage-chart")]
        .find((s) => s.getAttribute("aria-label") === label &&
          s.closest(".usage-context-view") && !s.closest(".usage-context-view").hidden);
      if (!chart) return { visible: false, text: "no visible chart" };
      const r = chart.getBoundingClientRect();
      chart.dispatchEvent(new PointerEvent("pointermove", {
        clientX: r.left + 30 + r.width * frac, clientY: r.top + r.height / 2, bubbles: true,
      }));
      const t = document.querySelector(".usage-tooltip");
      return { visible: getComputedStyle(t).display !== "none", text: t.textContent || "" };
    }
    const requestOf = (r) => {
      const m = (r.text || "").match(/Request (\\d+)/);
      return m ? Number(m[1]) : null;
    };
    window.__probe = { setView, hover, requestOf, errs: () => window.__errs };
    return "ready";
  })();
`;

async function run() {
  const html = buildCacheExportHtml(parseEntries(fixtureEntries()), { title: "e2e fixture", sessionId: "e2e" });

  const chrome = findChrome();
  if (!chrome) {
    console.log("  SKIP browser e2e (no Chrome/Chromium found; set BROWSER_BIN to enable)");
    skipped++;
    return;
  }
  const usesWindowsChrome = IS_WSL && /\.exe$/i.test(chrome);
  let windowsPid = 0;
  const port = await freePort();
  const userDataDir = usesWindowsChrome
    ? commandOutput("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "[Environment]::GetFolderPath('LocalApplicationData')"]) + `\\agent-web\\e2e-${process.pid}`
    : mkdtempSync(join(tmpdir(), "cache-export-e2e-"));

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--headless", "--disable-graphics", "--no-sandbox", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  ];
  if (usesWindowsChrome) {
    const winPath = commandOutput("wslpath", ["-w", chrome]);
    const quoted = chromeArgs.map((a) => `'${a.replaceAll("'", "''")}'`).join(", ");
    const out = commandOutput("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$p = Start-Process -FilePath '${winPath}' -ArgumentList @(${quoted}) -PassThru; $p.Id`]);
    windowsPid = Number(out.trim());
  } else {
    spawn(chrome, chromeArgs, { stdio: "ignore", detached: true }).unref();
  }

  try {
    if (!(await waitForEndpoint(port))) {
      check("browser endpoint comes up", false, "chrome did not expose :" + port);
      return;
    }
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === "page");
    const cdp = await cdpConnect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(html) });
    await cdp.send("Runtime.enable");

    const evalJs = async (expression) => {
      const res = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "eval failed");
      return res.result.value;
    };

    // wait for load + the dashboard IIFE
    for (let i = 0; i < 40; i++) {
      if (await evalJs(`document.readyState === "complete" && !!document.querySelector(".usage-chart")`)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await evalJs(HOVER_SCRIPT);

    // 1. segmentation: model switches create context segments
    const segInfo = await evalJs(`
      (() => {
        const opts = [...document.querySelectorAll("[data-context-segment-select] option")]
          .map((o) => ({ value: o.value, text: o.textContent }));
        return { count: opts.length - 1, selected: document.querySelector("[data-context-segment-select]").value, opts };
      })()
    `);
    check("e2e segments split at compactions AND model switches (4 expected)",
      segInfo.count === 4, JSON.stringify(segInfo.opts.map((o) => o.text)));
    check("e2e segment labels carry the model", segInfo.opts.some((o) => o.text.includes("· p/m2")), JSON.stringify(segInfo.opts));
    check("e2e defaults to the latest segment", segInfo.selected === "segment-4", segInfo.selected);

    // 2. All view: tooltip must work past every break, on every chart
    await evalJs(`window.__probe.setView("all")`);
    const allCharts = await evalJs(`
      (() => {
        const labels = [...document.querySelectorAll("svg.usage-chart")].map((s) => s.getAttribute("aria-label"));
        const out = {};
        for (const label of labels) {
          const near = window.__probe.hover(label, 0.05);
          const far = window.__probe.hover(label, 0.9);
          out[label] = { near, far, nearReq: window.__probe.requestOf(near), farReq: window.__probe.requestOf(far) };
        }
        return { out, errs: window.__probe.errs() };
      })()
    `);
    const labels = Object.keys(allCharts.out);
    check("e2e All view has 3 charts", labels.length === 3, labels.join(","));
    for (const label of labels) {
      const { near, far, nearReq, farReq } = allCharts.out[label];
      check(`e2e All "${label}" tooltip visible near start`, near.visible && nearReq !== null, JSON.stringify(near));
      check(`e2e All "${label}" tooltip works past the last break`, far.visible && farReq !== null && farReq > 39, JSON.stringify(far));
      check(`e2e All "${label}" tooltip tracks the cursor across breaks`, farReq !== nearReq, `${farReq} vs ${nearReq}`);
    }
    check("e2e no IndexSizeError / uncaught errors in All view",
      !allCharts.errs.some((e) => /IndexSizeError|Uncaught/i.test(e)), JSON.stringify(allCharts.errs));

    // 3. latest segment view (no internal breaks): full-width tooltips
    await evalJs(`window.__probe.setView("segment-4")`);
    const seg4 = await evalJs(`
      (() => {
        const near = window.__probe.hover("Prompt input by request", 0.05);
        const far = window.__probe.hover("Prompt input by request", 0.9);
        return { near, far, nearReq: window.__probe.requestOf(near), farReq: window.__probe.requestOf(far), errs: window.__probe.errs() };
      })()
    `);
    check("e2e segment-4 tooltip works at start and end",
      seg4.near.visible && seg4.far.visible && seg4.farReq !== seg4.nearReq,
      JSON.stringify(seg4));
    check("e2e segment view has no uncaught errors",
      !seg4.errs.some((e) => /IndexSizeError|Uncaught/i.test(e)), JSON.stringify(seg4.errs));

    cdp.close();
    if (usesWindowsChrome && windowsPid) {
      try { execFileSync("taskkill.exe", ["/PID", String(windowsPid), "/T", "/F"]); } catch { /* best effort */ }
    }
  } finally {
    if (!usesWindowsChrome) rmSync(userDataDir, { recursive: true, force: true });
  }
}

await run();
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped (browser e2e)`);
process.exit(fail ? 1 : 0);

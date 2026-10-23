// pi-cache-dashboard extension entry.
// Registers a single command: /cache_export
//   /cache_export              -> writes a tau-style interactive cache dashboard
//                                 HTML to ~/.cache/pi-cache-dashboard/<name>-<timestamp>.html
//   /cache_export ./report.html -> writes to the given path instead
//   /cache_export --open        -> also open it in the browser

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseEntries, buildCacheExportHtml } from "../src/render.ts";

const DEFAULT_DIR = join(homedir(), ".cache", "pi-cache-dashboard");

function isWsl() {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

// Open a file in the platform's default handler via spawnSync + argv arrays
// (no shell, so paths with $, quotes or backticks are safe). Returns true on success.
function openInBrowser(path) {
  try {
    let file = path;
    if (isWsl()) {
      // WSL has no Linux browser; convert the path and route through Windows.
      const r = spawnSync("wslpath", ["-w", file], { timeout: 10000, encoding: "utf8" });
      if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return false;
      file = r.stdout.trim();
      const s = spawnSync("cmd.exe", ["/c", "start", "", file], { timeout: 15000 });
      return s.status === 0;
    }
    if (process.platform === "darwin") {
      return spawnSync("open", [file], { timeout: 15000 }).status === 0;
    }
    if (process.platform === "win32") {
      return spawnSync("cmd", ["/c", "start", "", file], { timeout: 15000 }).status === 0;
    }
    return spawnSync("xdg-open", [file], { timeout: 15000 }).status === 0;
  } catch {
    return false;
  }
}

function sanitizeName(s) {
  return String(s || "session").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "session";
}

function defaultOutputPath(ctx) {
  const info = ctx.sessionManager;
  const sessionId = info.getSessionId ? info.getSessionId() : undefined;
  const sessionFile = info.getSessionFile ? info.getSessionFile() : undefined;
  const name = sessionFile ? sanitizeName(basename(sessionFile, ".jsonl")) : sanitizeName(sessionId || "session");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  return join(DEFAULT_DIR, `${name}-${stamp}.html`);
}

export default function (pi) {
  let observed;
  pi.on("turn_start", () => { observed = undefined; });
  pi.on("agent_end", () => { observed = undefined; });
  pi.on("session_start", () => { observed = undefined; });
  pi.on("before_provider_request", (event, ctx) => {
    if (!ctx.model) return;
    const payload = event.payload ?? {};
    const explicitTtlsSeconds = new Set();
    const controls = [
      payload.cache_control,
      ...(Array.isArray(payload.system) ? payload.system.map((block) => block?.cache_control) : []),
      ...(Array.isArray(payload.tools) ? payload.tools.map((tool) => tool?.cache_control) : []),
      ...(Array.isArray(payload.messages) ? payload.messages.flatMap((message) =>
        Array.isArray(message?.content) ? message.content.map((block) => block?.cache_control) : []) : []),
    ];
    for (const control of controls) {
      if (control?.type === "ephemeral" && control.ttl === "1h") explicitTtlsSeconds.add(3600);
      if (control?.type === "ephemeral" && control.ttl === "5m") explicitTtlsSeconds.add(300);
    }
    const retention = ["in_memory", "24h"].includes(payload.prompt_cache_retention) ? payload.prompt_cache_retention : null;
    if (retention === "24h") explicitTtlsSeconds.add(86400);
    const modelReference = {};
    for (const tier of ["short", "long"]) {
      const seconds = ctx.model.promptCache?.[tier];
      if (Number.isFinite(seconds) && seconds > 0) modelReference[tier] = seconds;
    }
    // Allowlist only. Never persist prompts, headers, URLs, cache keys, or tokens.
    observed = {
      provider: ctx.model.provider, model: ctx.model.id, api: ctx.model.api,
      observedAt: Date.now(),
      policy: { retention, explicitTtlsSeconds: [...explicitTtlsSeconds], modelReference },
    };
  });
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message?.role !== "assistant") return;
    if (observed && observed.provider === message.provider && observed.model === message.model && observed.api === message.api) {
      pi.appendEntry("cache-export-request", { ...observed, messageTimestamp: message.timestamp });
    }
    observed = undefined;
  });
  pi.registerCommand("cache_export", {
    description: "Export an interactive cache dashboard (latest Context segment by default, all-history switch, per-request charts)",
    handler: async (args, ctx) => {
      const sessionManager = ctx.sessionManager;
      const entries = typeof sessionManager.getBranch === "function"
        ? sessionManager.getBranch()
        : sessionManager.getEntries();
      if (!entries || entries.length === 0) {
        ctx.ui.notify("No session entries to analyze.", "error");
        return;
      }

      const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
      const doOpen = tokens.includes("--open") || tokens.includes("-o");
      const pathArg = tokens.find((t) => !t.startsWith("-"));

      const data = parseEntries(entries);
      if (data.requests.length === 0 && data.auxiliary.length === 0) {
        ctx.ui.notify("No main or auxiliary usage data yet.", "error");
        return;
      }
      const info = ctx.sessionManager;
      const sessionId = info.getSessionId ? info.getSessionId() : undefined;
      const outPath = pathArg ? resolve(ctx.cwd, pathArg) : defaultOutputPath(ctx);

      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buildCacheExportHtml(data, { title: "cache export", sessionId }), "utf8");
      ctx.ui.notify(`Cache dashboard: ${outPath}`, "success");
      if (doOpen) {
        const ok = openInBrowser(outPath);
        if (!ok) ctx.ui.notify(`Could not auto-open; open manually: ${outPath}`, "warning");
      }
    },
  });
}

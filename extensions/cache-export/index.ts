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
import { parseEntries, buildCacheExportHtml } from "./render.ts";

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
  pi.registerCommand("cache_export", {
    description: "Export a tau-style interactive cache dashboard (hit-rate charts, per-request table, events)",
    handler: async (args, ctx) => {
      const entries = ctx.sessionManager.getEntries();
      if (!entries || entries.length === 0) {
        ctx.ui.notify("No session entries to analyze.", "error");
        return;
      }

      const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
      const doOpen = tokens.includes("--open") || tokens.includes("-o");
      const pathArg = tokens.find((t) => !t.startsWith("-"));

      const data = parseEntries(entries);
      if (data.requests.length === 0) {
        ctx.ui.notify("No assistant requests with usage data yet.", "error");
        return;
      }
      const info = ctx.sessionManager;
      const sessionId = info.getSessionId ? info.getSessionId() : undefined;
      const outPath = resolve(pathArg || defaultOutputPath(ctx));

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

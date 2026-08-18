// tau-style usage/cache dashboard renderer.
// Logic ported from huggingface/tau src/tau_coding/session_usage.py (render_usage_dashboard),
// interactivity/styles auto-extracted into ./tau-assets.mjs.

import { USAGE_STYLES, USAGE_SCRIPT } from "./tau-assets.ts";

// ---------------------------------------------------------------------------
// Data aggregation from pi session entries
// ---------------------------------------------------------------------------

function hhmmss(ts) {
  const iso = String(ts || "");
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  // render in the machine's local timezone (Asia/Shanghai here -> Beijing time)
  return d.toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function tzLabel() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const offMin = -new Date().getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const off = `${sign}${String(Math.trunc(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${tz} (UTC${off})`;
}

export function parseEntries(entries) {
  const requests = [];
  const events = [];
  const toolCounts = {};
  let compactions = 0;
  let prevKey = null;
  const longCacheUntilByKey = new Map();
  let gapTools = []; // tool results accumulated since the previous request

  const addEvent = (num, kind, label, ts) =>
    events.push({ requestNumber: num, timestamp: hhmmss(ts), kind, label });

  for (const e of entries || []) {
    const t = e?.type;
    const ts = e?.timestamp;
    if (t === "compaction") {
      compactions += 1;
      addEvent(requests.length + 1, "compaction", "Compaction", ts);
      continue;
    }
    if (t === "model_change") {
      const mid = e.modelId || e.model || "?";
      const prov = e.provider ? `${e.provider}/` : "";
      addEvent(requests.length + 1, "model", `Model changed to ${prov}${mid}`, ts);
      continue;
    }
    if (t === "thinking_level_change") {
      const lvl = e.thinkingLevel || e.level || "off";
      addEvent(requests.length + 1, "thinking", `Thinking changed to ${lvl}`, ts);
      continue;
    }
    if (t !== "message") continue;
    const m = e.message;
    if (!m || m.role !== "assistant") {
      if (m && m.role === "toolResult") {
        let chars = 0;
        for (const blk of m.content || []) {
          if (blk && typeof blk === "object" && typeof blk.text === "string") chars += blk.text.length;
        }
        gapTools.push({ tool: m.toolName || "?", chars });
      }
      continue;
    }

    // pi stores tool calls inside assistant content blocks
    for (const blk of m.content || []) {
      if (blk && typeof blk === "object" && blk.type === "toolCall") {
        const name = blk.tool || blk.name || "?";
        toolCounts[name] = (toolCounts[name] || 0) + 1;
      }
    }

    const u = m.usage;
    if (!u) continue;
    const fresh = u.input || 0;
    const cached = u.cacheRead || 0;
    const cacheWrite = u.cacheWrite || 0;
    const output = u.output || 0;
    if (fresh + cached + cacheWrite + output === 0) continue;

    const num = requests.length + 1;
    const provider = m.provider || "?";
    const model = m.model || "?";
    const api = m.api || "";
    const key = `${provider}/${model}`;
    if (prevKey !== null && key !== prevKey && !events.some((ev) => ev.requestNumber === num && ev.kind === "model")) {
      addEvent(num, "model", `Model changed to ${provider}/${model}`, ts);
    }
    prevKey = key;

    const tsMs = Date.parse(String(ts || ""));
    let longCacheUntil = longCacheUntilByKey.get(key) || 0;
    if (u.cacheRead === 0 && u.cacheWrite > 0 && !u.cacheWrite1h) {
      longCacheUntil = 0;
      longCacheUntilByKey.delete(key);
    }
    if (u.cacheWrite1h > 0 && Number.isFinite(tsMs)) {
      longCacheUntil = Math.max(longCacheUntil, tsMs + LONG_TTL_MINUTES * 60000);
      longCacheUntilByKey.set(key, longCacheUntil);
    }
    const cacheTtlMinutes = Number.isFinite(tsMs) && tsMs <= longCacheUntil
      ? LONG_TTL_MINUTES
      : DEFAULT_TTL_MINUTES;

    const cost = u.cost && typeof u.cost.total === "number" ? u.cost.total : null;
    requests.push({
      number: num,
      isoTs: String(ts || ""),
      timestamp: hhmmss(ts),
      provider,
      model,
      api,
      responseProvider: null,
      fresh,
      cached,
      cacheWrite,
      cacheWrite1h: u.cacheWrite1h || 0,
      cacheTtlMinutes,
      output,
      reasoning: u.reasoning || 0,
      stopReason: m.stopReason || "",
      estimatedCost: cost,
      gapTools,
      prevOutput: requests.length ? requests[requests.length - 1].output : 0,
    });
    gapTools = [];
  }

  const toolCalls = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
  return { requests, events, toolCalls, compactions };
}

// ---------------------------------------------------------------------------
// Helpers (ported from session_usage.py)
// ---------------------------------------------------------------------------

function esc(s, quote = false) {
  let out = String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  if (quote) out = out.replaceAll('"', "&quot;");
  return out;
}

const SERIES_COLORS = {
  // [dark, light] - derived from tau's built-in themes
  cached: ["#a7f3f0", "#0f766e"],
  "cache writes": ["#9cffb1", "#166534"],
  fresh: ["#ff4f4f", "#b91c1c"],
  request: ["#ff4f4f", "#b91c1c"],
  cumulative: ["#93c5fd", "#2563eb"],
  output: ["#c084fc", "#9333ea"],
  reasoning: ["#9cffb1", "#166534"],
  event: ["#a7f3f0", "#0f766e"],
};
const seriesColor = (name) => SERIES_COLORS[name] || ["#93c5fd", "#2563eb"];

function compactNumber(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "m";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "k";
  return v.toFixed(0);
}

function fmtCost(v) {
  if (v === null || v === undefined) return "$N/A";
  if (v > 0 && v < 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

const fmtInt = (n) => n.toLocaleString("en-US");
const fmtPct1 = (x) => (x * 100).toFixed(1) + "%";

// ---------------------------------------------------------------------------
// _line_chart port
// ---------------------------------------------------------------------------

function lineChart(title, series, opts = {}) {
  const { yMax = null, percent = false, timestamps = null, events = [] } = opts;
  const width = 900, height = 330, left = 68, right = 20, top = 42, bottom = 52;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const count = Math.max(0, ...series.map(([, v]) => v.length));
  const observedMax = Math.max(0, ...series.map(([, v]) => Math.max(0, ...v)));
  let maximum = yMax || Math.max(observedMax, 1);
  if (!percent) {
    const magnitude = 10 ** Math.max(0, String(Math.trunc(maximum)).length - 1);
    maximum = Math.ceil(maximum / magnitude) * magnitude;
  }

  const point = (index, value) => [
    left + (index / Math.max(count - 1, 1)) * plotWidth,
    top + plotHeight - (value / maximum) * plotHeight,
  ];

  const tsAttr = timestamps ? ` data-timestamps="${esc(timestamps.join("|"), true)}"` : "";
  const parts = [
    `<svg class="usage-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title, true)}" data-left="${left}" data-right="${right}" data-count="${count}"${tsAttr}>`,
    `<text class="chart-title" x="${left}" y="24">${esc(title)}</text>`,
  ];
  for (let tick = 0; tick < 6; tick++) {
    const value = (maximum * tick) / 5;
    const y = top + plotHeight - (tick * plotHeight) / 5;
    const label = percent ? `${(value * 100).toFixed(0)}%` : compactNumber(value);
    parts.push(
      `<line class="grid" x1="${left}" y1="${y.toFixed(1)}" x2="${width - right}" y2="${y.toFixed(1)}"/>` +
        `<text class="tick" x="${left - 9}" y="${(y + 4).toFixed(1)}" text-anchor="end">${label}</text>`,
    );
  }
  for (let index = 0; index < count; index++) {
    if (count <= 20 || index % Math.max(1, Math.trunc(count / 12)) === 0 || index === count - 1) {
      const [x] = point(index, 0);
      parts.push(`<text class="tick" x="${x.toFixed(1)}" y="${height - 22}" text-anchor="middle">${index + 1}</text>`);
    }
  }
  parts.push(
    `<line class="hover-line" x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}" visibility="hidden"/>`,
  );
  const [evDark, evLight] = seriesColor("event");
  events
    .filter((event) => event.requestNumber >= 1 && event.requestNumber <= count)
    .forEach((event, eventIndex) => {
      const [x] = point(Math.max(0, Math.min(count - 1, event.requestNumber - 1)), 0);
      const markerY = top + 7 + (eventIndex % 3) * 9;
      const description = `${event.label} before request ${event.requestNumber} at ${event.timestamp}`;
      parts.push(
        `<g class="usage-event usage-event-${esc(event.kind, true)}" data-request="${event.requestNumber}" ` +
          `data-event-info="${esc(description, true)}" role="img" aria-label="${esc(description, true)}">` +
          `<title>${esc(description)}</title>` +
          `<line class="event-line" data-dark="${evDark}" data-light="${evLight}" x1="${x.toFixed(1)}" y1="${top}" x2="${x.toFixed(1)}" y2="${top + plotHeight}" stroke="${evDark}"/>` +
          `<circle class="event-marker" data-dark="${evDark}" data-light="${evLight}" cx="${x.toFixed(1)}" cy="${markerY.toFixed(1)}" r="4" fill="${evDark}"/></g>`,
      );
    });
  series.forEach(([name, values], seriesIndex) => {
    const [dark, light] = seriesColor(name);
    const points = values.map((value, i) => point(i, value).map((c) => c.toFixed(1)).join(",")).join(" ");
    const labels = values.map((v) => (percent ? `${(v * 100).toFixed(1)}%` : fmtInt(Math.trunc(v)))).join("|");
    parts.push(
      `<g class="series" data-series-id="${seriesIndex}" data-name="${esc(name, true)}" data-labels="${esc(labels, true)}">` +
        `<polyline class="series-line" data-dark="${dark}" data-light="${light}" points="${points}" fill="none" stroke="${dark}" stroke-width="3"/>` +
        `<circle class="hover-point" data-dark="${dark}" data-light="${light}" r="5" fill="${dark}" visibility="hidden"/></g>`,
    );
  });
  let legendX = width - right;
  [...series].reverse().forEach(([name], i) => {
    const seriesIndex = series.length - 1 - i;
    const [dark, light] = seriesColor(name);
    legendX -= 18 + name.length * 8;
    parts.push(
      `<g class="series-toggle" data-series-id="${seriesIndex}" role="button" tabindex="0" aria-pressed="true">` +
        `<circle class="series-swatch" data-dark="${dark}" data-light="${light}" cx="${legendX.toFixed(1)}" cy="20" r="4" fill="${dark}"/>` +
        `<text class="legend" x="${(legendX + 8).toFixed(1)}" y="24">${esc(name)}</text></g>`,
    );
  });
  parts.push(
    `<text class="axis-label" x="${(left + plotWidth / 2).toFixed(1)}" y="${height - 4}" text-anchor="middle">Model request</text></svg>`,
  );
  return parts.join("");
}

export function lineChartForTest(title, series, opts) {
  return lineChart(title, series, opts);
}

const figure = (chart) =>
  `<figure class="usage-figure">${chart}<button type="button" class="png-button" title="Download this chart as a PNG image">PNG</button></figure>`;

// ---------------------------------------------------------------------------
// Rule-based (non-LLM) cache-miss attribution
// ---------------------------------------------------------------------------

const MISS_THRESHOLD = 0.5; // hit rate below this gets an explanation row
const PREFIX_REUSE_THRESHOLD = 0.5;
const DEFAULT_TTL_MINUTES = 5;
const LONG_TTL_MINUTES = 60;

function reusablePrefix(request) {
  const prompt = request.fresh + request.cached + request.cacheWrite;
  if (request.api !== "anthropic-messages") return prompt;
  const explicitlyCached = request.cached + request.cacheWrite;
  return explicitlyCached > 0 ? explicitlyCached : prompt;
}

function ttlMinutesAfter(request) {
  return request.cacheTtlMinutes ?? (request.cacheWrite1h > 0 ? LONG_TTL_MINUTES : DEFAULT_TTL_MINUTES);
}

export function analyzeMisses(requests, events) {
  const evByReq = new Map();
  for (const ev of events) {
    if (!evByReq.has(ev.requestNumber)) evByReq.set(ev.requestNumber, []);
    evByReq.get(ev.requestNumber).push(ev);
  }

  const noCacheReporting = requests.every((r) => r.cached === 0 && r.cacheWrite === 0);
  const misses = [];
  const summary = new Map();

  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    const prompt = r.fresh + r.cached + r.cacheWrite;
    if (prompt <= 0) continue;
    const hit = r.cached / prompt;
    if (hit >= MISS_THRESHOLD) continue;

    const causes = [];
    const prev = i > 0 ? requests[i - 1] : null;
    const expectedPrefix = prev ? reusablePrefix(prev) : 0;
    const prefixReuse = expectedPrefix > 0 ? Math.min(1, r.cached / expectedPrefix) : 0;

    if (i === 0) {
      causes.push(["first request", "cold session: nothing cached yet; the prefix can only be reused by a later request"]);
    }
    if (prev && (prev.provider !== r.provider || prev.model !== r.model)) {
      causes.push(["model switch", `${prev.provider}/${prev.model} -> ${r.provider}/${r.model}: prefix invalidated by provider/model change`]);
    }
    for (const ev of evByReq.get(r.number) || []) {
      if (ev.kind === "compaction") {
        causes.push(["compaction", "context was rewritten by compaction; cache rebuilds on the new prefix"]);
      } else if (ev.kind === "model" && r.number > 1 && !causes.some(([c]) => c === "model switch")) {
        causes.push(["model switch", `${ev.label}: prefix invalidated by provider/model change`]);
      } else if (ev.kind === "thinking" && r.number > 1) {
        causes.push(["thinking change", `${ev.label}: request parameters changed`]);
      }
    }
    if (prev && r.isoTs && prev.isoTs) {
      const gapMin = (Date.parse(r.isoTs) - Date.parse(prev.isoTs)) / 60000;
      const ttlMinutes = ttlMinutesAfter(prev);
      if (gapMin > ttlMinutes && prefixReuse < PREFIX_REUSE_THRESHOLD && !causes.some(([c]) => c === "compaction" || c === "model switch")) {
        causes.push(["possible TTL expiry", `idle gap ${gapMin.toFixed(0)}min > ${ttlMinutes}min heuristic; actual retention depends on the provider`]);
      }
    }
    if (prev && prefixReuse < PREFIX_REUSE_THRESHOLD && !causes.length) {
      const writeDetail = r.cacheWrite > 0 ? `; provider also reported ${r.cacheWrite.toLocaleString("en-US")} tokens written for the replacement prefix` : "";
      causes.push(["cache rebuild", `only ${(prefixReuse * 100).toFixed(1)}% of the prior reusable prefix was read; the cache was likely lost or invalidated${writeDetail}`]);
    }
    if (r.cacheWrite > 0 && !causes.length) {
      causes.push(["cache write", `provider reported ${r.cacheWrite.toLocaleString("en-US")} tokens written; a low read-hit rate is expected while a prefix is created or extended`]);
    }
    if (prev && !causes.length) {
      const toolChars = (r.gapTools || []).reduce((sum, tool) => sum + tool.chars, 0);
      const toolTokens = Math.round(toolChars / 4);
      const toolDetail = toolTokens > 0 ? `, including ~${toolTokens.toLocaleString("en-US")} estimated tool-output tokens` : "";
      causes.push(["new input", `reused ${(prefixReuse * 100).toFixed(1)}% of the prior prefix; ${r.fresh.toLocaleString("en-US")} fresh tokens were newly appended${toolDetail}`]);
    }
    if (!causes.length) {
      causes.push(["unclassified", "no rule matched; usually new content appended beyond the cached prefix (large tool results / long user input)"]);
    }

    for (const [cause] of causes) {
      const s = summary.get(cause) || { count: 0, fresh: 0 };
      s.count += 1;
      s.fresh += r.fresh;
      summary.set(cause, s);
    }
    misses.push({ number: r.number, timestamp: r.timestamp, hit, fresh: r.fresh, causes });
  }

  const summaryArr = [...summary.entries()].sort((a, b) => b[1].fresh - a[1].fresh);
  return { misses, summary: summaryArr, noCacheReporting, threshold: MISS_THRESHOLD,
    ttlMinutes: DEFAULT_TTL_MINUTES, longTtlMinutes: LONG_TTL_MINUTES };
}

// Streak detection: many consecutive requests stuck in a mid hit-rate band.
// Persistent mid-band hit rate usually means each turn appends a lot of new
// content (big tool outputs / long replies), not a broken cache.
// Band starts at 50% so it lines up with the miss panel (<50%); per-request
// fresh must exceed STREAK_MIN_FRESH so tiny early-session prefixes (where a
// few hundred fresh tokens drag the ratio down) do not create fake streaks.
const STREAK_LOW = 0.5;
const STREAK_HIGH = 0.975;
const STREAK_MIN_LEN = 3;
const STREAK_MIN_FRESH = 800;   // tokens per request to count as a streak member
const STREAK_MIN_PROMPT = 4000; // ignore tiny prefixes where ratios are meaningless
// Requests that report cacheWrite are cache-creation/rebuild events, not
// append-heavy read-hit streak members, so they terminate the current streak.

export function analyzeStreaks(requests, events = []) {
  const streaks = [];
  let cur = null;
  let gaps = 0; // consecutive non-member requests inside the current run
  let prevKey = null;
  const resetBefore = new Set(events
    .filter((event) => event.kind === "compaction" || event.kind === "model")
    .map((event) => event.requestNumber));
  const close = () => {
    if (cur && cur.hits.length >= STREAK_MIN_LEN) streaks.push(cur);
    cur = null;
    gaps = 0;
  };
  for (const r of requests) {
    const key = `${r.provider}/${r.model}`;
    if ((prevKey !== null && key !== prevKey) || resetBefore.has(r.number)) close();
    prevKey = key;
    if (r.cacheWrite > 0) {
      close();
      continue;
    }
    const prompt = r.fresh + r.cached;
    let hit = 0;
    let member = false;
    if (prompt >= STREAK_MIN_PROMPT) {
      hit = r.cached / prompt;
      member = hit >= STREAK_LOW && hit < STREAK_HIGH && r.fresh >= STREAK_MIN_FRESH;
    }
    if (member) {
      if (!cur) cur = { from: r.number, to: r.number, hits: [], fresh: 0, tools: new Map(), replyTokens: 0 };
      cur.to = r.number;
      cur.hits.push(hit);
      cur.fresh += r.fresh;
      cur.replyTokens += r.prevOutput;
      for (const g of r.gapTools || []) {
        const tok = Math.round(g.chars / 4); // ~4 chars per token
        cur.tools.set(g.tool, (cur.tools.get(g.tool) || 0) + tok);
      }
      gaps = 0;
    } else if (cur) {
      // tolerate a single healthy/outlier turn inside a streak; two end it
      gaps += 1;
      if (gaps >= 2) close();
    }
  }
  close();
  for (const s of streaks) {
    s.avgHit = s.hits.reduce((a, b) => a + b, 0) / s.hits.length;
    s.toolList = [...s.tools.entries()].sort((a, b) => b[1] - a[1]);
    s.toolTokens = s.toolList.reduce((sum, [, v]) => sum + v, 0);
    // how much of the fresh tokens the trace can explain (heuristic)
    s.coverage = s.fresh > 0 ? Math.min(1, (s.toolTokens + s.replyTokens) / s.fresh) : 0;
  }
  return streaks;
}

function renderStreakPanel(streaks) {
  const rows = streaks
    .map((s) => {
      const tools = s.toolList
        .slice(0, 4)
      .map(([t, v]) => `${esc(t)} ${fmtInt(v)}`)
        .join(", ");
      const pct = (x) => (x * 100).toFixed(1) + "%";
      return `<tr><td>#${s.from}–#${s.to}</td><td>${s.hits.length}</td><td>${pct(s.avgHit)}</td>` +
        `<td>${fmtInt(s.fresh)}</td>` +
        `<td style="white-space:normal">tool outputs: ${tools || "-"} · assistant replies: ${fmtInt(s.replyTokens)} · trace explains ~${pct(s.coverage)} of fresh</td></tr>`;
    })
    .join("");
  return `<div class="usage-panel"><h2>Hit-rate streak analysis</h2>` +
    `<p class="usage-note">Rule-based, no LLM. A streak is ${STREAK_MIN_LEN}+ requests (single healthy outlier tolerated) with hit rate ` +
    `${(STREAK_LOW * 100).toFixed(0)}–${(STREAK_HIGH * 100).toFixed(1)}% (requests reporting cacheWrite break the streak; fresh ≥ ${STREAK_MIN_FRESH} tok, prefix ≥ ${STREAK_MIN_PROMPT}): ` +
    `usually each turn appends large fresh content (big tool outputs / long replies), not a cache failure. ` +
    `Below ${(MISS_THRESHOLD * 100).toFixed(0)}% see the miss panel above. Tool tokens estimated at 4 chars/token.</p>` +
    `<div class="usage-table-wrap" style="max-height:260px"><table>` +
    `<thead><tr><th>Requests</th><th>Turns</th><th>Avg hit</th><th>Total fresh</th><th>Trace (fresh composition)</th></tr></thead>` +
    `<tbody>${rows || `<tr><td colspan="5" class="empty">No mid-band streaks found.</td></tr>`}</tbody></table></div></div>`;
}

function renderMissPanel(miss) {
  if (miss.noCacheReporting) {
    return `<div class="usage-panel"><h2>Cache miss analysis</h2>` +
      `<p class="empty">No cache reads or writes were reported. The provider may omit cache token fields, caching may be disabled, or this session may not have reused a prefix; hit rate cannot be determined.</p></div>`;
  }
  const summaryHtml = miss.summary
    .map(([cause, s]) => `<div class="usage-tool"><span>${esc(cause)} (${s.count})</span><strong>${fmtInt(s.fresh)} fresh</strong></div>`)
    .join("") || `<p class="empty">No request fell below ${(miss.threshold * 100).toFixed(0)}% hit rate.</p>`;
  const rows = miss.misses
    .map((m) =>
      `<tr><td>${m.number}</td><td>${esc(m.timestamp)}</td><td>${fmtPct1(m.hit)}</td><td>${fmtInt(m.fresh)}</td>` +
      `<td style="white-space:normal">${m.causes.map(([c, d]) => `<strong>${esc(c)}</strong>: ${esc(d)}`).join("<br>")}</td></tr>`,
    )
    .join("");
  return `<div class="usage-panel"><h2>Cache miss analysis</h2>` +
    `<p class="usage-note">Rule-based attribution, no LLM. Rows are requests below ${(miss.threshold * 100).toFixed(0)}% hit rate. ` +
    `TTL attribution uses a ${miss.ttlMinutes}min idle-gap heuristic, or ${miss.longTtlMinutes}min after a reported 1h cache write; actual retention is provider-specific.</p>` +
    `<div class="usage-table-wrap" style="max-height:340px"><table>` +
    `<thead><tr><th>#</th><th>Time</th><th>Hit rate</th><th>Fresh</th><th>Cause</th></tr></thead>` +
    `<tbody>${rows || `<tr><td colspan="5" class="empty">None</td></tr>`}</tbody></table></div>` +
    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-top:12px">${summaryHtml}</div></div>`;
}

// ---------------------------------------------------------------------------
// render_usage_dashboard port
// ---------------------------------------------------------------------------

export function renderDashboard(data) {
  const { requests, events, toolCalls, compactions } = data;
  if (!requests.length) {
    return `<p class="empty">No assistant responses with token usage were found in this session.</p>`;
  }

  const timestamps = requests.map((r) => r.timestamp);
  const cached = requests.map((r) => r.cached);
  const cacheWrites = requests.map((r) => r.cacheWrite);
  const fresh = requests.map((r) => r.fresh);
  const outputs = requests.map((r) => r.output);
  const reasoning = requests.map((r) => r.reasoning);
  const rates = requests.map((r) => (r.fresh + r.cached + r.cacheWrite > 0 ? r.cached / (r.fresh + r.cached + r.cacheWrite) : 0));
  const cumulativeRates = [];
  let runCached = 0, runPrompt = 0;
  for (const r of requests) {
    runCached += r.cached;
    runPrompt += r.fresh + r.cached + r.cacheWrite;
    cumulativeRates.push(runPrompt > 0 ? runCached / runPrompt : 0);
  }

  const tot = (f) => requests.reduce((s, r) => s + f(r), 0);
  const totalFresh = tot((r) => r.fresh), totalCached = tot((r) => r.cached),
    totalWrite = tot((r) => r.cacheWrite), totalPrompt = totalFresh + totalCached + totalWrite,
    totalOutput = tot((r) => r.output);

  const cacheHitRate = totalPrompt > 0 && (totalCached > 0 || totalWrite > 0) ? totalCached / totalPrompt : null;

  const cards = [
    ["Model requests", fmtInt(requests.length)],
    ["Cache hit rate", cacheHitRate !== null ? fmtPct1(cacheHitRate) : "N/A"],
    ["Cached input", fmtInt(totalCached)],
    ["Reported cache writes", fmtInt(totalWrite)],
    ["Fresh input", fmtInt(totalFresh)],
    ["Total prompt input", fmtInt(totalPrompt)],
    ["Output tokens", fmtInt(totalOutput)],
    ["Compactions", String(compactions)],
  ];
  const cardsHtml = cards
    .map(([l, v]) => `<div class="usage-card"><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`)
    .join("");

  const charts = [
    figure(lineChart("Prompt input by request",
      [["cached", cached], ["cache writes", cacheWrites], ["fresh", fresh]],
      { timestamps, events })),
  ];
  if (cacheHitRate !== null) {
    charts.push(figure(lineChart("Cache hit rate",
      [["request", rates], ["cumulative", cumulativeRates]],
      { yMax: 1.0, percent: true, timestamps })));
  }
  charts.push(figure(lineChart("Output and reasoning tokens",
    [["output", outputs], ["reasoning", reasoning]], { timestamps })));

  const showHit = cacheHitRate !== null;
  const rows = requests
    .map((r) =>
      `<tr><td>${r.number}</td><td>${esc(r.timestamp)}</td><td>${esc(r.provider)}</td>` +
      `<td>${r.responseProvider ? esc(r.responseProvider) : "-"}</td>` +
      `<td>${esc(r.model)}</td><td>${fmtInt(r.fresh)}</td><td>${fmtInt(r.cached)}</td>` +
      `<td>${fmtInt(r.cacheWrite)}</td><td>${fmtInt(r.fresh + r.cached + r.cacheWrite)}</td>` +
      `<td>${showHit ? fmtPct1(r.cached / Math.max(1, r.fresh + r.cached + r.cacheWrite)) : "N/A"}</td>` +
      `<td>${fmtInt(r.output)}</td><td>${esc(r.stopReason, true)}</td></tr>`,
    )
    .join("");

  const toolRows =
    toolCalls.map(([name, c]) => `<div class="usage-tool"><span>${esc(name)}</span><strong>${c}</strong></div>`).join("") ||
    `<p class="empty">No tool calls.</p>`;

  return (
    `<div class="usage-cards">${cardsHtml}</div>` +
    `<p class="usage-note">Hover a request for exact values, ` +
    `select a legend item to hide a series, and use PNG to save a chart. Event markers show ` +
    `compactions, model or thinking changes. Some providers report cache reads but not cache writes.</p>` +
    `<div class="usage-charts">${charts.join("")}</div>` +
    renderMissPanel(analyzeMisses(requests, events)) +
    renderStreakPanel(analyzeStreaks(requests, events)) +
    `<div class="usage-details">` +
    `<div class="usage-panel"><h2>Requests</h2><div class="usage-table-wrap"><table>` +
    `<thead><tr><th>#</th><th>Time</th><th>Provider</th><th>Response Provider</th><th>Model</th>` +
    `<th>Fresh</th><th>Cached</th><th>Written</th><th>Prompt</th><th>Hit rate</th><th>Output</th>` +
    `<th>Stop</th></tr></thead><tbody>${rows}</tbody></table></div></div>` +
    `<div class="usage-panel"><h2>Tool calls</h2>${toolRows}</div>` +
    `</div><div class="usage-tooltip" role="status" aria-live="polite"></div>`
  );
}

// ---------------------------------------------------------------------------
// Full page
// ---------------------------------------------------------------------------

export function buildCacheExportHtml(data, opts = {}) {
  const title = opts.title || "cache export";
  const n = data.requests.length;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root {
  --bg: #000000; --surface: #101419; --surface-2: #161b21; --text: #d8dee9;
  --bright: #e5e7eb; --muted: #667085; --line: #141922; --line-strong: #2d3748;
  --accent: #a7f3f0; --accent-text: #061a1a; --accent-soft: #a7f3f0;
  --mono: "JetBrains Mono", "SFMono-Regular", Consolas, Menlo, monospace;
}
html { background: var(--bg); }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 15px; line-height: 1.6; }
main { max-width: 1080px; margin: 0 auto; padding: 40px 24px 80px; }
.eyebrow { color: var(--accent); font-size: .68rem; letter-spacing: .18em; text-transform: uppercase; }
.eyebrow::before { content: "$ "; color: var(--muted); }
h1 { color: var(--bright); font-size: 1.6rem; font-weight: 500; margin: 6px 0 4px; }
.sub { color: var(--muted); font-size: .78rem; margin: 0 0 30px; }
.usage-shell { margin-top: 18px; }
/* keep hover points visible on dark page chrome for both chart palettes */
.hover-point { stroke: #ffffff; stroke-width: 2; }
${USAGE_STYLES}
</style></head>
<body><main>
<div class="eyebrow">usage &amp; cache</div>
<h1>${esc(title)}</h1>
<p class="sub">tau-style dashboard rendered by pi-cache-dashboard · ${n} requests · times in ${esc(tzLabel())}${opts.sessionId ? " · session " + esc(opts.sessionId) : ""}</p>
<section class="usage-shell" id="panel-usage">${renderDashboard(data)}</section>
<script>${USAGE_SCRIPT}</script>
</main></body></html>`;
}

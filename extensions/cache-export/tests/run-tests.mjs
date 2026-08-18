// Deterministic test cases for analyzeStreaks / analyzeMisses / parseEntries.
// Run: node --experimental-strip-types tests/run-tests.mjs
import { parseEntries, analyzeStreaks, analyzeMisses } from "../render.ts";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

// helpers -------------------------------------------------------------
const T0 = "2026-01-01T00:00:00Z";
function req({ cached, fresh, write = 0, out = 100, min = 0, provider = "p", model = "m", content = [] }) {
  return { type: "message", timestamp: `2026-01-01T00:${String(min).padStart(2, "0")}:00Z`,
    message: { role: "assistant", provider, model, stopReason: "stop", content, usage: { input: fresh, cacheRead: cached, cacheWrite: write, output: out } } };
}
function toolResult(text, tool = "bash") {
  return { type: "message", message: { role: "toolResult", toolName: tool, content: [{ type: "text", text }] } };
}
const hitOf = (r) => r.cached / (r.fresh + r.cached + r.cacheWrite);

// A. healthy session: no streaks ---------------------------------------
{
  const entries = Array.from({ length: 4 }, (_, i) => req({ cached: 99000, fresh: 1000, min: i }));
  const d = parseEntries(entries);
  const s = analyzeStreaks(d.requests);
  check("A healthy 99% session -> no streaks", s.length === 0, `got ${s.length}`);
}

// B. classic streak ----------------------------------------------------
{
  const entries = Array.from({ length: 5 }, (_, i) => req({ cached: 90000, fresh: 10000, min: i }));
  const d = parseEntries(entries);
  const s = analyzeStreaks(d.requests);
  check("B 5x hit90/fresh10k -> 1 streak of 5", s.length === 1 && s[0].hits.length === 5, JSON.stringify(s.map(x => [x.from, x.to])));
  check("B avgHit ~0.9", s[0] && Math.abs(s[0].avgHit - 0.9) < 0.01);
}

// C. tiny-prefix fake streak must be suppressed ------------------------
{
  const entries = Array.from({ length: 4 }, (_, i) => req({ cached: 10000, fresh: 500, min: i })); // hit .952, fresh 500
  const d = parseEntries(entries);
  const s = analyzeStreaks(d.requests);
  check("C 4x hit95 but fresh<800 -> no streak (fake suppressed)", s.length === 0, `got ${s.length}`);
}

// D. old blind spot: persistent 60-80% with big fresh must be caught ----
{
  const entries = Array.from({ length: 4 }, (_, i) => req({ cached: 30000, fresh: 15000, min: i })); // hit .667
  const d = parseEntries(entries);
  const s = analyzeStreaks(d.requests);
  check("D 4x hit67/fresh15k -> 1 streak (blind spot covered)", s.length === 1 && s[0].hits.length === 4);
}

// E. streak with a single healthy turn in the middle (gap tolerance) -------
{
  const entries = [
    req({ cached: 90000, fresh: 10000, min: 1 }),
    req({ cached: 90000, fresh: 10000, min: 2 }),
    req({ cached: 90000, fresh: 10000, min: 3 }),
    req({ cached: 99000, fresh: 1000, min: 4 }),  // single healthy outlier -> tolerated
    req({ cached: 90000, fresh: 10000, min: 5 }),
    req({ cached: 90000, fresh: 10000, min: 6 }),
  ];
  const s = analyzeStreaks(parseEntries(entries).requests);
  check("E single healthy outlier tolerated -> one 5-member streak",
    s.length === 1 && s[0].hits.length === 5, JSON.stringify(s.map(x => x.hits.length)));
}

// E2. two consecutive healthy turns DO end a streak ----------------------
{
  const entries = [
    req({ cached: 90000, fresh: 10000, min: 1 }),
    req({ cached: 90000, fresh: 10000, min: 2 }),
    req({ cached: 90000, fresh: 10000, min: 3 }),
    req({ cached: 99000, fresh: 1000, min: 4 }),
    req({ cached: 99000, fresh: 1000, min: 5 }), // 2nd healthy -> closes
    req({ cached: 90000, fresh: 10000, min: 6 }),
    req({ cached: 90000, fresh: 10000, min: 7 }),
  ];
  const s = analyzeStreaks(parseEntries(entries).requests);
  check("E2 two healthy turns end streak -> two streaks (3 + 2 dropped)",
    s.length === 1 && s[0].hits.length === 3, JSON.stringify(s.map(x => x.hits.length)));
}

// F. model switch breaks streak + miss attribution ---------------------
{
  const entries = [
    req({ cached: 90000, fresh: 10000, min: 1, model: "a" }),
    req({ cached: 90000, fresh: 10000, min: 2, model: "a" }),
    req({ cached: 90000, fresh: 10000, min: 3, model: "a" }),
    { type: "model_change", timestamp: "2026-01-01T00:03:30Z", provider: "p", modelId: "b" },
    req({ cached: 0, fresh: 50000, min: 4, model: "b" }),   // full miss
    req({ cached: 99000, fresh: 1000, min: 5, model: "b" }),
  ];
  const d = parseEntries(entries);
  const s = analyzeStreaks(d.requests);
  const m = analyzeMisses(d.requests, d.events);
  check("F streak len 3 (broken by switch)", s.length === 1 && s[0].hits.length === 3);
  const sw = m.misses.find((x) => x.number === 4);
  check("F request4 miss attributed to model switch", sw && sw.causes.some(([c]) => c === "model switch"), JSON.stringify(m.misses.map((x) => [x.number, x.causes.map((y) => y[0])])));
  check("F only 1 miss total (request4)", m.misses.length === 1, `got ${m.misses.length}`);
}

// G. band boundaries ----------------------------------------------------
{
  const mk3 = (cached, fresh) => Array.from({ length: 3 }, (_, i) => req({ cached, fresh, min: i + 1 }));
  check("G hit=0.50 (inclusive) -> streak", analyzeStreaks(parseEntries(mk3(5000, 5000)).requests).length === 1);
  check("G hit=0.98 -> no streak (above band)", analyzeStreaks(parseEntries(mk3(98000, 2000)).requests).length === 0);
  const exact = analyzeStreaks(parseEntries(mk3(39000, 1000)).requests).length; // 39000/40000 = 0.975 boundary
  check("G hit=0.975 boundary excluded (high bound exclusive)", exact === 0, `got ${exact}`);
  check("G fresh=800 exactly -> member (>= threshold)", analyzeStreaks(parseEntries(mk3(7200, 800)).requests).length === 1); // hit .9
  check("G fresh=799 -> not member", analyzeStreaks(parseEntries(mk3(7190, 799)).requests).length === 0);
}

// H. TTL expiry attribution ---------------------------------------------
{
  const entries = [
    req({ cached: 50000, fresh: 2000, min: 1 }),
    req({ cached: 5000, fresh: 15000, min: 40 }), // 39min gap same model, hit .25
  ];
  const m = analyzeMisses(parseEntries(entries).requests, parseEntries(entries).events);
  check("H 39min gap + low hit -> TTL expiry", m.misses.length === 1 && m.misses[0].causes.some(([c]) => c === "TTL expiry"),
    JSON.stringify(m.misses.map((x) => x.causes)));
}

// I. cache rebuild (prev turn was a miss, same model) -------------------
{
  const entries = [
    req({ cached: 0, fresh: 100000, min: 1 }),
    req({ cached: 400, fresh: 140000, min: 2 }), // 1min later, prev was total miss
  ];
  const d = parseEntries(entries);
  const m = analyzeMisses(d.requests, d.events);
  const two = m.misses.find((x) => x.number === 2);
  check("I request2 -> cache rebuild (prev lost cache)", two && two.causes.some(([c]) => c === "cache rebuild"), JSON.stringify(m.misses.map((x) => [x.number, x.causes.map((y) => y[0])])));
}

// J. trailing event clamp + tool trace ----------------------------------
{
  const entries = [
    req({ cached: 90000, fresh: 10000, min: 1, content: [{ type: "toolCall", tool: "bash", name: "bash" }] }),
    toolResult("x".repeat(12000)),
    req({ cached: 90000, fresh: 10000, min: 2 }),
    toolResult("y".repeat(4000), "read"),
    req({ cached: 90000, fresh: 10000, min: 3 }),
    { type: "compaction", timestamp: "2026-01-01T00:59:00Z" }, // after last request
  ];
  const d = parseEntries(entries);
  const lastEv = d.events[d.events.length - 1];
  check("J trailing compaction clamped to last request", lastEv.kind === "compaction" && lastEv.requestNumber === 3, JSON.stringify(lastEv));
  const s = analyzeStreaks(d.requests);
  check("J streak tool trace has bash~3000 + read~1000 tokens",
    s.length === 1 && s[0].tools.get("bash") === 3000 && s[0].tools.get("read") === 1000,
    JSON.stringify(s[0] && [...s[0].tools.entries()]));
}

// L. interleaved churn (alternating bad/healthy) must not escape ----------
{
  const entries = [];
  for (let i = 0; i < 4; i++) {
    entries.push(req({ cached: 30000, fresh: 15000, min: entries.length + 1 })); // hit .667
    entries.push(req({ cached: 99000, fresh: 1000, min: entries.length + 1 }));  // hit .99
  }
  const s = analyzeStreaks(parseEntries(entries).requests);
  check("L alternating churn (4 bad turns interleaved) -> 1 streak with 4 members",
    s.length === 1 && s[0].hits.length === 4, JSON.stringify(s.map(x => x.hits.length)));
}

// M. write-heavy rebuild (Anthropic-style) must not fake a mid-band streak --
{
  const entries = Array.from({ length: 3 }, (_, i) =>
    req({ cached: 5000, fresh: 2000, write: 50000, min: i + 1 })); // std hit 8.8%, write-excluded hit .714
  const s = analyzeStreaks(parseEntries(entries).requests);
  check("M write-heavy rebuild counts members by write-excluded hit",
    s.length === 1 && s[0].hits.length === 3, JSON.stringify(s.map(x => x.hits.length)));
}

// N. tiny prefix (fresh>=800 but prompt<4000) must not streak ---------------
{
  const entries = Array.from({ length: 4 }, (_, i) => req({ cached: 2000, fresh: 1000, min: i + 1 })); // hit .667, prompt 3k
  const s = analyzeStreaks(parseEntries(entries).requests);
  check("N tiny prefix (<4k) -> no streak even though fresh>=800", s.length === 0, `got ${s.length}`);
}

// K. degenerate inputs ---------------------------------------------------
{
  check("K empty session -> no crash, no streaks", analyzeStreaks(parseEntries([]).requests).length === 0);
  const single = parseEntries([req({ cached: 1000, fresh: 9000, min: 1 })]).requests;
  check("K single low-hit request -> miss(first request), no streak", analyzeMisses(single, []).misses[0].causes.some(([c]) => c === "first request") && analyzeStreaks(single).length === 0);
  const zero = parseEntries([{ type: "message", message: { role: "assistant", provider: "p", model: "m", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } }]).requests;
  check("K all-zero usage entry skipped", zero.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

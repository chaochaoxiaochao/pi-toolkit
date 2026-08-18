// Deterministic test cases for analyzeStreaks / analyzeMisses / parseEntries.
// Run: node --experimental-strip-types tests/run-tests.mjs
import { parseEntries, analyzeStreaks, analyzeMisses, lineChartForTest } from "../render.ts";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

// helpers -------------------------------------------------------------
const T0 = "2026-01-01T00:00:00Z";
function req({ cached, fresh, write = 0, write1h = 0, out = 100, min = 0, provider = "p", model = "m", api = "openai-responses", content = [] }) {
  return { type: "message", timestamp: `2026-01-01T00:${String(min).padStart(2, "0")}:00Z`,
    message: { role: "assistant", provider, model, api, stopReason: "stop", content,
      usage: { input: fresh, cacheRead: cached, cacheWrite: write, cacheWrite1h: write1h, output: out } } };
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
  check("H 39min gap + low hit -> possible TTL expiry", m.misses.length === 1 && m.misses[0].causes.some(([c]) => c === "possible TTL expiry"),
    JSON.stringify(m.misses.map((x) => x.causes)));
}

// H2. long idle gap with retained prefix is new input, not TTL expiry -------
{
  const entries = [
    req({ cached: 0, fresh: 14000, min: 1 }),
    toolResult("x".repeat(80000), "read"),
    req({ cached: 13824, fresh: 20000, min: 40 }),
  ];
  const d = parseEntries(entries);
  const two = analyzeMisses(d.requests, d.events).misses.find((x) => x.number === 2);
  check("H2 long gap with 98% prefix reuse -> new input, not TTL",
    two && two.causes.some(([cause]) => cause === "new input") && !two.causes.some(([cause]) => cause === "possible TTL expiry"),
    JSON.stringify(two && two.causes));
}

// H3. Anthropic 1h writes suppress the 5min TTL heuristic -----------------
{
  const entries = [
    req({ cached: 0, fresh: 2000, write: 50000, write1h: 50000, min: 1, api: "anthropic-messages" }),
    req({ cached: 5000, fresh: 15000, min: 40, api: "anthropic-messages" }),
  ];
  const d = parseEntries(entries);
  const two = analyzeMisses(d.requests, d.events).misses.find((x) => x.number === 2);
  check("H3 39min gap after 1h write -> rebuild, not TTL expiry",
    two && two.causes.some(([cause]) => cause === "cache rebuild") && !two.causes.some(([cause]) => cause === "possible TTL expiry"),
    JSON.stringify(two && two.causes));
}

// H4. 1h retention survives intervening read-only requests -----------------
{
  const entries = [
    req({ cached: 0, fresh: 2000, write: 50000, write1h: 50000, min: 1, api: "anthropic-messages" }),
    req({ cached: 50000, fresh: 2000, min: 2, api: "anthropic-messages" }),
    req({ cached: 5000, fresh: 15000, min: 40, api: "anthropic-messages" }),
  ];
  const d = parseEntries(entries);
  const three = analyzeMisses(d.requests, d.events).misses.find((x) => x.number === 3);
  check("H4 inherited 1h window -> rebuild, not TTL expiry",
    d.requests[1].cacheTtlMinutes === 60 && three && three.causes.some(([cause]) => cause === "cache rebuild") &&
      !three.causes.some(([cause]) => cause === "possible TTL expiry"),
    JSON.stringify({ ttl: d.requests[1].cacheTtlMinutes, causes: three && three.causes }));
}

// H5. short-lived replacement clears an older 1h retention window ----------
{
  const entries = [
    req({ cached: 0, fresh: 2000, write: 50000, write1h: 50000, min: 1, api: "anthropic-messages" }),
    req({ cached: 0, fresh: 2000, write: 50000, min: 2, api: "anthropic-messages" }),
    req({ cached: 5000, fresh: 15000, min: 12, api: "anthropic-messages" }),
  ];
  const d = parseEntries(entries);
  const three = analyzeMisses(d.requests, d.events).misses.find((x) => x.number === 3);
  check("H5 short replacement resets TTL to 5min",
    d.requests[1].cacheTtlMinutes === 5 && three && three.causes.some(([cause]) => cause === "possible TTL expiry"),
    JSON.stringify({ ttl: d.requests[1].cacheTtlMinutes, causes: three && three.causes }));
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

// I2. cold start followed by large tool output keeps the prior prefix -------
{
  const entries = [
    req({ cached: 0, fresh: 14080, min: 1 }),
    toolResult("a".repeat(30142), "fetch_content"),
    toolResult("b".repeat(50662), "read"),
    toolResult("c".repeat(30719), "read"),
    req({ cached: 13824, fresh: 27347, min: 2 }),
  ];
  const d = parseEntries(entries);
  const two = analyzeMisses(d.requests, d.events).misses.find((x) => x.number === 2);
  check("I2 request2 retained 98% prior prefix -> new input, not rebuild",
    two && two.causes.some(([c]) => c === "new input") && !two.causes.some(([c]) => c === "cache rebuild"),
    JSON.stringify(two && two.causes));
  check("I2 new-input detail includes estimated tool tokens",
    two && two.causes.some(([, detail]) => detail.includes("27,881 estimated tool-output tokens")),
    JSON.stringify(two && two.causes));
}

// I3. OpenAI previous fresh suffix remains part of reusable prefix --------
{
  const entries = [
    req({ cached: 80000, fresh: 20000, min: 1 }),
    req({ cached: 45000, fresh: 55000, min: 2 }),
  ];
  const d = parseEntries(entries);
  const two = analyzeMisses(d.requests, d.events).misses.find((x) => x.number === 2);
  check("I3 OpenAI 45% of prior total prompt -> rebuild",
    two && two.causes.some(([cause]) => cause === "cache rebuild"), JSON.stringify(two && two.causes));
}

// J. trailing event stays after the final request + tool trace ------------
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
  check("J trailing compaction remains after request 3", lastEv.kind === "compaction" && lastEv.requestNumber === 4, JSON.stringify(lastEv));
  const chart = lineChartForTest("events", [["cached", [1, 2, 3]]], { events: d.events });
  check("J trailing compaction is not drawn as if it preceded request 3", !chart.includes("usage-event-compaction"));
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

// M. cacheWrite is excluded from the read-hit streak metric --------------
{
  const entries = Array.from({ length: 3 }, (_, i) =>
    req({ cached: 5000, fresh: 2000, write: 50000, min: i + 1, api: "anthropic-messages" })); // read hit 8.8%
  const d = parseEntries(entries);
  const s = analyzeStreaks(d.requests);
  const m = analyzeMisses(d.requests, d.events);
  check("M cacheWrite requests break append-heavy streaks", s.length === 0, JSON.stringify(s));
  check("M repeated writes with only 9% prior-prefix reads are rebuilds",
    m.misses.length === 3 && m.misses.slice(1).every((miss) => miss.causes.some(([cause]) => cause === "cache rebuild")),
    JSON.stringify(m.misses.map((miss) => miss.causes)));
}

// M2. retained Anthropic prefix plus a new write is cache extension --------
{
  const entries = [
    req({ cached: 50000, fresh: 2000, min: 1, api: "anthropic-messages" }),
    req({ cached: 50000, fresh: 2000, write: 60000, min: 2, api: "anthropic-messages" }),
  ];
  const d = parseEntries(entries);
  const two = analyzeMisses(d.requests, d.events).misses.find((x) => x.number === 2);
  check("M2 retained prefix plus write -> cache write, not rebuild",
    two && two.causes.some(([cause]) => cause === "cache write") && !two.causes.some(([cause]) => cause === "cache rebuild"),
    JSON.stringify(two && two.causes));
}

// N. tiny prefix (fresh>=800 but prompt<4000) must not streak ---------------
{
  const entries = Array.from({ length: 4 }, (_, i) => req({ cached: 2000, fresh: 1000, min: i + 1 })); // hit .667, prompt 3k
  const s = analyzeStreaks(parseEntries(entries).requests);
  check("N tiny prefix (<4k) -> no streak even though fresh>=800", s.length === 0, `got ${s.length}`);
}

// O. model switch must split mid-band streaks immediately ----------------
{
  const entries = [
    ...Array.from({ length: 3 }, (_, i) => req({ cached: 90000, fresh: 10000, min: i + 1, model: "a" })),
    ...Array.from({ length: 3 }, (_, i) => req({ cached: 90000, fresh: 10000, min: i + 4, model: "b" })),
  ];
  const s = analyzeStreaks(parseEntries(entries).requests);
  check("O model switch splits streaks into 3 + 3",
    s.length === 2 && s.every((x) => x.hits.length === 3), JSON.stringify(s.map((x) => [x.from, x.to])));
}

// P. compaction must split mid-band streaks -------------------------------
{
  const entries = [
    ...Array.from({ length: 3 }, (_, i) => req({ cached: 90000, fresh: 10000, min: i + 1 })),
    { type: "compaction", timestamp: "2026-01-01T00:03:30Z" },
    ...Array.from({ length: 3 }, (_, i) => req({ cached: 90000, fresh: 10000, min: i + 4 })),
  ];
  const d = parseEntries(entries);
  const s = analyzeStreaks(d.requests, d.events);
  check("P compaction splits streaks into 3 + 3",
    s.length === 2 && s.every((x) => x.hits.length === 3), JSON.stringify(s.map((x) => [x.from, x.to])));
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

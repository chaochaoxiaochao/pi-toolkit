import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../extensions/cache-export.ts";
import { parseEntries, analyzeMisses, buildContextSegments, renderDashboard } from "../src/render.ts";

const origin = Date.parse("2026-01-01T00:00:00Z");
const iso = (seconds) => new Date(origin + seconds * 1000).toISOString();
const usage = (read = 0, write = 0) => ({ input: 10000, cacheRead: read, cacheWrite: write, output: 100 });
const request = (start, duration, read = 0, extraUsage = {}) => ({
  type: "message", timestamp: iso(start + duration),
  message: { role: "assistant", provider: "p", model: "m", api: "openai-codex-responses", timestamp: origin + start * 1000, durationMs: duration * 1000, content: [], usage: { ...usage(read), ...extraUsage } },
});
const misses = (data) => analyzeMisses(data.requests, data.events).misses;
const hasTtl = (data) => misses(data).some((miss) => miss.causes.some(([cause]) => cause === "possible TTL expiry"));
{
  const data = parseEntries([request(0, 6, 50000), request(12, 408)]);
  assert.equal(data.requests[1].startGapMs, 12000, "response persistence times are not request starts");
  assert.equal(data.requests[1].idleMs, 6000);
  assert.equal(data.requests[1].durationMs, 408000);
  assert.equal(hasTtl(data), false);
  assert.equal(data.requests[0].policyReferenceSeconds, null, "never assign Codex a generic five-minute TTL");
  assert.equal(data.requests[0].reasoning, null, "unreported reasoning is unknown, not zero");
  const html = renderDashboard(data);
  assert.match(html, /Unknown/);
  assert.match(html, /segment cumulative/);
  assert.match(html, /request sequence/);
}
{
  const data = parseEntries([
    request(0, 1, 0, { cacheWrite: 50000, cacheWrite1h: 50000 }),
    request(59 * 60, 1, 50000), request(61 * 60, 1, 50000), request(70 * 60, 1),
  ]);
  assert.equal(data.requests[0].policyReferenceSeconds, 3600);
  assert.equal(data.requests[2].policyReferenceSeconds, null, "do not invent a five-minute expiry after an old one-hour write");
  assert.equal(hasTtl(data), false, "reported reads do not reveal the server's next expiry time");
}
{
  const warm = { type: "usage", kind: "cache_warm", timestamp: iso(480), provider: "p", model: "m", usage: usage(50000) };
  const data = parseEntries([request(0, 1, 50000), warm, { type: "compaction", timestamp: iso(540), usage: usage(10) }, request(600, 1)]);
  assert.equal(data.requests.length, 2);
  assert.equal(data.auxiliary.length, 2);
  assert.match(renderDashboard(data), /Auxiliary usage/);
  const warmed = parseEntries([request(0, 1, 50000), warm, request(600, 1)]);
  assert.equal(warmed.requests[1].lastWarmAt, origin + 480000);
  const planned = parseEntries([request(0, 1, 50000), { type: "custom", customType: "cache_warming_decision", timestamp: iso(480) }, request(600, 1)]);
  assert.equal(planned.auxiliary.length, 0, "preparing a warm request is not completed usage");
  assert.equal(planned.requests[1].lastWarmAt, null);
}
{
  const data = parseEntries([request(0, 1, 50000), { type: "context_edit", timestamp: iso(30) }, request(60, 1)]);
  const segments = buildContextSegments(data.requests, data.events);
  assert.equal(segments.length, 2);
  const segmentMiss = analyzeMisses(segments[1].requests, data.events).misses[0];
  assert.ok(segmentMiss.causes.some(([cause]) => cause === "context edit"));
  assert.ok(!segmentMiss.causes.some(([cause]) => cause === "first request"), "a segment is not the session's first request");
}
{
  const root = mkdtempSync(join(tmpdir(), "cache-evidence-"));
  try {
    const handlers = new Map(), entries = [], saved = [];
    let command;
    register({
      on: (name, handler) => handlers.set(name, handler),
      appendEntry: (customType, data) => { saved.push(data); entries.push({ type: "custom", customType, data }); },
      registerCommand: (_name, value) => { command = value; },
    });
    const ctx = { cwd: root, model: { provider: "p", id: "m", api: "openai-responses", promptCache: { short: 300, long: 86400 } }, sessionManager: { getBranch: () => entries }, ui: { notify() {} } };
    const message = request(0, 1, 50000);
    message.message.api = "openai-responses";
    await handlers.get("turn_start")({}, ctx);
    await handlers.get("before_provider_request")({ payload: { prompt_cache_retention: "24h", prompt_cache_key: "PRIVATE_KEY", input: "PRIVATE_PROMPT", headers: { Authorization: "PRIVATE_TOKEN" } } }, ctx);
    await handlers.get("message_end")({ message: message.message }, ctx);
    entries.push(message);
    assert.equal(saved.length, 1);
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE|Authorization|prompt_cache_key/);
    assert.equal(parseEntries(entries).requests[0].policyReferenceSeconds, 86400);
    await command.handler("report.html", ctx);
    assert.ok(readFileSync(join(root, "report.html"), "utf8").includes("cache export"));
    assert.equal(parseEntries([message]).requests[0].policyReferenceSeconds, null, "current model configuration must never backfill old entries");
    const longGap = request(90000, 1);
    const crossed = parseEntries([...entries, longGap]);
    assert.equal(hasTtl(crossed), true, "crossing an observed reference may be labeled possible, never proven");
    assert.match(JSON.stringify(misses(crossed)), /not an idle gap or a server expiry measurement/);
    const warm = { type: "usage", kind: "cache_warm", timestamp: iso(89990), provider: "p", model: "m", usage: usage(10000) };
    assert.equal(hasTtl(parseEntries([...entries, warm, longGap])), false, "do not use the main-request gap as if completed warming did not occur");
    const mixedMessage = request(100000, 1, 50000, { cacheWrite: 10000, cacheWrite1h: 5000 });
    mixedMessage.message.api = "anthropic-messages";
    ctx.model.api = "anthropic-messages";
    await handlers.get("turn_start")({}, ctx);
    await handlers.get("before_provider_request")({ payload: { messages: [{ content: [
      { text: "PRIVATE_TEXT", cache_control: { type: "ephemeral", ttl: "5m" } },
      { cache_control: { type: "ephemeral", ttl: "1h" } },
    ] }] } }, ctx);
    await handlers.get("message_end")({ message: mixedMessage.message }, ctx);
    const mixedEvidence = entries.at(-1);
    const later = request(104001, 1);
    later.message.api = "anthropic-messages";
    const mixedData = parseEntries([mixedEvidence, mixedMessage, later]);
    assert.deepEqual(mixedData.requests[0].policy.explicitTtlsSeconds, [300, 3600]);
    assert.equal(mixedData.requests[0].policyReferenceSeconds, null, "a partial one-hour write cannot override known mixed TTLs");
    assert.equal(hasTtl(mixedData), false, "do not attribute the later miss to an invented whole-request TTL");
    assert.equal(parseEntries([mixedMessage]).requests[0].policyReferenceSeconds, null, "mixed write counters alone also preclude a whole-request TTL");
    for (const oneHourWrite of [0, 10000]) {
      const variant = structuredClone(mixedMessage);
      variant.message.usage.cacheWrite1h = oneHourWrite;
      assert.equal(parseEntries([mixedEvidence, variant]).requests[0].policyReferenceSeconds, null, "known mixed policy remains unknown regardless of this response's write mix");
    }
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
console.log("PASS cache evidence: timing, unknown retention/reasoning, auxiliary usage, context edits, safe history, session cwd");

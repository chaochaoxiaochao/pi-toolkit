import "../../background-tasks/tests/runtime.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cacheExport from "../extensions/cache-export.ts";
import { parseEntries } from "../src/render.ts";
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const root = mkdtempSync(join(tmpdir(), "cache-sdk-"));
const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), refreshOnCreate: false });
let session;
try {
  runtime.registerProvider("cache-fixture", {
    api: "cache-fixture", apiKey: "not-secret", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "offline", name: "Offline", input: ["text"], reasoning: false, contextWindow: 128000, maxTokens: 4096, promptCache: { short: 300, long: 86400 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const timestamp = Date.now();
      queueMicrotask(async () => {
        await options.onPayload?.({ prompt_cache_retention: "24h", prompt_cache_key: "SECRET_KEY", input: "SECRET_PAYLOAD" }, model);
        const message = { role: "assistant", provider: model.provider, api: model.api, model: model.id, timestamp, durationMs: 10, content: [{ type: "text", text: "offline" }], stopReason: "stop", usage: { input: 100, output: 1, cacheRead: 1000, cacheWrite: 0, totalTokens: 1101, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [cacheExport] });
  await resourceLoader.reload();
  const created = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel("cache-fixture", "offline"), resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root), tools: [] });
  session = created.session;
  assert.deepEqual(created.extensionsResult.errors, []);
  const errors = [];
  session.extensionRunner.onError((error) => errors.push(error));
  await session.bindExtensions({});
  await session.prompt("Produce deterministic usage.");
  const entries = session.sessionManager.getBranch();
  const data = parseEntries(entries);
  assert.equal(data.requests.length, 1);
  assert.equal(data.requests[0].policyReferenceSeconds, 86400, "native hook observation must survive projection and match its assistant message");
  assert.equal(data.requests[0].durationMs, 10);
  assert.doesNotMatch(JSON.stringify(entries), /SECRET_KEY|SECRET_PAYLOAD/);
  await session.prompt("/cache_export native.html");
  assert.match(readFileSync(join(root, "native.html"), "utf8"), /86400s recorded reference/);
  assert.deepEqual(errors, []);
  console.log("PASS native Pi cache export: safe request evidence, message correlation, session-relative path");
} finally {
  if (session) { await session.abort(); session.dispose(); }
  rmSync(root, { recursive: true, force: true });
}

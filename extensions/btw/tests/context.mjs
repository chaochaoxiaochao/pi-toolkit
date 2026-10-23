// Exercise the real SessionManager projection and actual provider input.
import "../../../packages/background-tasks/tests/runtime.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { default: btw } = await import("../index.ts");

const root = mkdtempSync(join(tmpdir(), "btw-context-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalCwd = process.cwd();
process.chdir(root);
process.env.PI_CODING_AGENT_DIR = root;
const settings = { retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" };
writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), refreshOnCreate: false });
const requests = [];
const sessions = new Set();
runtime.registerProvider("btw-fixture", {
  name: "Offline fixture", api: "btw-fixture", apiKey: "not-secret", baseUrl: "http://127.0.0.1:1",
  models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple(model, context) {
    requests.push(structuredClone(context));
    const answer = `ANSWER_${requests.length}`;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: "text", text: answer }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  },
});
async function create(manager) {
  const settingsManager = SettingsManager.inMemory(settings);
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [btw] });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel("btw-fixture", "offline"), thinkingLevel: "off", resourceLoader: loader, sessionManager: manager, settingsManager, tools: [] });
  assert.deepEqual(extensionsResult.errors, []);
  sessions.add(session);
  await session.bindExtensions({});
  return session;
}
async function dispose(session) {
  await session.abort();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  sessions.delete(session);
}
try {
  const manager = SessionManager.inMemory(root);
  const parent = await create(manager);
  await parent.prompt("MAIN_CONTEXT");
  const mainMessages = structuredClone(parent.messages);
  await parent.prompt("/btw SIDE_FIRST");
  assert.equal(requests.length, 2);
  for (const text of ["MAIN_CONTEXT", "ANSWER_1", "SIDE_FIRST"]) assert.ok(JSON.stringify(requests[1].messages).includes(text), `first BTW request lost ${text}`);
  await parent.prompt("/btw SIDE_SECOND");
  assert.equal(requests.length, 3);
  for (const text of ["MAIN_CONTEXT", "SIDE_FIRST", "ANSWER_2", "SIDE_SECOND"]) assert.ok(JSON.stringify(requests[2].messages).includes(text), `continuous side session lost ${text}`);
  assert.deepEqual(parent.messages, mainMessages, "side messages must stay outside the main context");
  await dispose(parent);
  const restored = await create(manager);
  await restored.prompt("/btw SIDE_RESTORED");
  assert.equal(requests.length, 4);
  for (const text of ["MAIN_CONTEXT", "ANSWER_1", "SIDE_FIRST", "ANSWER_2", "SIDE_SECOND", "ANSWER_3", "SIDE_RESTORED"]) {
    assert.ok(JSON.stringify(requests[3].messages).includes(text), `restored BTW request lost ${text}`);
  }
  console.log("PASS BTW provider input: main history, continuous side session, restored side history, main-context isolation");
} finally {
  for (const session of sessions) await dispose(session);
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
}

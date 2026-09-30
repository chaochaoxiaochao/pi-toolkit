import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { modelIsAllowed } from "../model-routing.ts";

const extensionDir = dirname(dirname(new URL(import.meta.url).pathname));

test("config is next to the extension entry file", async () => {
  const source = await readFile(join(extensionDir, "index.ts"), "utf8");
  assert.match(source, /new URL\("\.\/config\.json", import\.meta\.url\)/);
  assert.match(source, /model-routing\.ts/);
  const config = JSON.parse(await readFile(join(extensionDir, "config.json"), "utf8"));
  assert.equal(config.enabled, true);
  assert.deepEqual(config.models, ["gpt-5.6-*"]);
});

test("matches allowed model IDs with globs independently of provider and grammar support", () => {
  const settings = { enabled: true, models: ["gpt-5.6-*"] };
  const baseModel = {
    id: "gpt-5.6-terra",
    api: "openai-codex-responses",
    compat: { supportsOpenAIGrammarTools: true },
  };
  assert.equal(modelIsAllowed({ ...baseModel, provider: "openai-codex" }, settings), true);
  assert.equal(modelIsAllowed({ ...baseModel, provider: "another-provider" }, settings), true);
  assert.equal(modelIsAllowed({ ...baseModel, compat: { supportsOpenAIGrammarTools: false } }, settings), true);
  assert.equal(
    modelIsAllowed(
      { ...baseModel, api: "openai-responses", compat: { sessionAffinityFormat: "openai-nosession" } },
      settings,
    ),
    true,
  );
  assert.equal(modelIsAllowed({ ...baseModel, api: "openai-completions" }, settings), false);
  assert.equal(modelIsAllowed({ ...baseModel, id: "gpt-5.5" }, settings), false);
  assert.equal(modelIsAllowed(baseModel, { enabled: false, models: ["gpt-5.6-*"] }), false);
});

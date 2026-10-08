import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { modelIsAllowed } from "../src/model-routing.ts";

const packageDir = dirname(dirname(new URL(import.meta.url).pathname));

test("package points Pi at the extension and config is reachable from it", async () => {
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions/codex-edit.ts"]);
  const source = await readFile(join(packageDir, "extensions/codex-edit.ts"), "utf8");
  assert.match(source, /new URL\("\.\.\/config\.json", import\.meta\.url\)/);
  assert.match(source, /model-routing\.ts/);
  assert.match(source, /parameters: Type\.Object\(\{\s*patch: Type\.String/);
  assert.match(source, /applyUpdateGroups\(before, operation\.chunkGroups, operation\.path\)/);
  const config = JSON.parse(await readFile(join(packageDir, "config.json"), "utf8"));
  assert.equal(config.enabled, true);
  assert.deepEqual(config.models, ["gpt-5.6-*"]);
});

test("matches allowed model IDs with globs independently of provider and grammar support", () => {
  const settings = { enabled: true, models: ["gpt-5.6-*", "my-codex-model"] };
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
  assert.equal(modelIsAllowed({ ...baseModel, id: "my-codex-model" }, settings), true);
  assert.equal(modelIsAllowed({ ...baseModel, id: "my-codex-model-v2" }, settings), false);
  assert.equal(modelIsAllowed({ ...baseModel, id: "GPT-5.6-terra" }, settings), false);
  assert.equal(modelIsAllowed(baseModel, { enabled: false, models: ["gpt-5.6-*"] }), false);
});

test("execution keeps a resolved-path conflict guard after parser coalescing", async () => {
  const source = await readFile(join(packageDir, "extensions/codex-edit.ts"), "utf8");
  assert.match(source, /new Set\(targets\)\.size !== targets\.length/);
  assert.match(source, /Multiple patch operations target the same resolved path/);
});

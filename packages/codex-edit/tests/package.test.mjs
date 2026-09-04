import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

const packageDir = dirname(dirname(new URL(import.meta.url).pathname));

test("package config is next to the extension parent directory", async () => {
  const source = await readFile(join(packageDir, "extensions", "codex-edit.ts"), "utf8");
  assert.match(source, /new URL\("\.\.\/config\.json", import\.meta\.url\)/);
  const config = JSON.parse(await readFile(join(packageDir, "config.json"), "utf8"));
  assert.equal(config.enabled, true);
  assert.ok(config.models.some((model) => model.model === "gpt-5.6-*"));
});

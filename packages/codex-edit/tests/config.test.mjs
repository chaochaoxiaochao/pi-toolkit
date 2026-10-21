import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSettings } from "../src/config.ts";
import { modelIsAllowed } from "../src/model-routing.ts";

async function fixture(t) {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-edit-config-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  return { agentDir, path: join(agentDir, "codex-edit.json") };
}

test("missing user config preserves package defaults without creating a file", async (t) => {
  const { agentDir, path } = await fixture(t);
  assert.deepEqual(await loadSettings(agentDir), { enabled: true, models: ["gpt-5.6-*"] });
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("partial user config overrides enabled while inheriting package models", async (t) => {
  const { agentDir, path } = await fixture(t);
  await writeFile(path, JSON.stringify({ enabled: false }));
  assert.deepEqual(await loadSettings(agentDir), { enabled: false, models: ["gpt-5.6-*"] });
});

test("user model list replaces defaults and keeps API routing restrictions", async (t) => {
  const { agentDir, path } = await fixture(t);
  await writeFile(path, JSON.stringify({ models: ["gpt-6.1-sol"] }));
  const settings = await loadSettings(agentDir);
  assert.deepEqual(settings, { enabled: true, models: ["gpt-6.1-sol"] });
  const model = { id: "gpt-6.1-sol", api: "openai-codex-responses" };
  assert.equal(modelIsAllowed(model, settings), true);
  assert.equal(modelIsAllowed({ ...model, api: "openai-responses" }, settings), true);
  assert.equal(modelIsAllowed({ ...model, api: "anthropic-messages" }, settings), false);
  assert.equal(modelIsAllowed({ ...model, id: "gpt-5.6-sol" }, settings), false);
});

test("empty models and explicit false are not replaced by defaults", async (t) => {
  const { agentDir, path } = await fixture(t);
  await writeFile(path, JSON.stringify({ enabled: false, models: [] }));
  assert.deepEqual(await loadSettings(agentDir), { enabled: false, models: [] });
  await writeFile(path, JSON.stringify({ models: [] }));
  assert.deepEqual(await loadSettings(agentDir), { enabled: true, models: [] });
});

test("malformed JSON and invalid known fields fail visibly with the config path", async (t) => {
  const { agentDir, path } = await fixture(t);
  for (const input of ["{", "null", "[]", "true", '"text"', '{"enabled":"false"}',
    '{"enabled":null}', '{"models":"gpt-*"}', '{"models":null}', '{"models":[1]}',
    '{"models":[""]}', '{"models":["   "]}']) {
    await writeFile(path, input);
    await assert.rejects(loadSettings(agentDir), (error) => {
      assert.ok(error.message.includes(path), `${input}: missing config path`);
      return true;
    });
  }
});

test("config read errors other than missing files are not ignored", async (t) => {
  const { agentDir, path } = await fixture(t);
  await mkdir(path);
  await assert.rejects(loadSettings(agentDir), (error) => {
    assert.ok(error.message.includes(path));
    return true;
  });
});

test("reload reads updated user rules without rewriting either config", async (t) => {
  const { agentDir, path } = await fixture(t);
  const defaultsUrl = new URL("../config.json", import.meta.url);
  const defaultsBefore = await readFile(defaultsUrl, "utf8");
  await writeFile(path, JSON.stringify({ models: ["gpt-6.1-sol"], note: "preserve unknown fields" }));
  assert.deepEqual((await loadSettings(agentDir)).models, ["gpt-6.1-sol"]);
  const next = JSON.stringify({ models: ["custom-*"], note: "preserve unknown fields" });
  await writeFile(path, next);
  assert.deepEqual((await loadSettings(agentDir)).models, ["custom-*"]);
  assert.equal(await readFile(path, "utf8"), next);
  assert.equal(await readFile(defaultsUrl, "utf8"), defaultsBefore);
});

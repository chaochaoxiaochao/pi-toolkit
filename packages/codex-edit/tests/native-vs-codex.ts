import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import registerCodexEdit from "../extensions/codex-edit.ts";
import { comparisonCases } from "./comparison-cases.mjs";

async function writeSnapshot(root, snapshot) {
  for (const [path, content] of Object.entries(snapshot)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
}

async function readSnapshot(root, relative = "") {
  const snapshot = {};
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(snapshot, await readSnapshot(root, path));
    else snapshot[path] = await readFile(join(root, path), "utf8");
  }
  return snapshot;
}

async function runNativeCase(testCase) {
  if (testCase.outcomes.native === "unsupported") {
    assert.equal(testCase.nativeCalls, null, `${testCase.id}: unsupported native case must not invent edit calls`);
    return "unsupported";
  }
  const workspace = await mkdtemp(join(tmpdir(), "codex-edit-native-"));
  try {
    await writeSnapshot(workspace, testCase.input);
    const edit = createEditToolDefinition(workspace);
    try {
      for (const [index, call] of testCase.nativeCalls.entries()) {
        await edit.execute(`native-${index}`, call, undefined, undefined, { cwd: workspace });
      }
      if (testCase.outcomes.native !== "pass") {
        assert.fail(`${testCase.id}: native edit unexpectedly succeeded`);
      }
      assert.deepEqual(await readSnapshot(workspace), testCase.expected);
      return "pass";
    } catch (error) {
      if (testCase.outcomes.native === "pass") throw error;
      return "fail";
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function getCodexTool() {
  let tool;
  await registerCodexEdit({
    registerTool(definition) { tool = definition; },
    on() {},
    getActiveTools() { return []; },
  });
  assert.ok(tool, "Codex Edit extension did not register apply_patch");
  return tool;
}

async function runCodexCase(tool, testCase) {
  const workspace = await mkdtemp(join(tmpdir(), "codex-edit-local-"));
  try {
    await writeSnapshot(workspace, testCase.input);
    try {
      await tool.execute("codex-local", { patch: testCase.patch }, undefined, undefined, {
        cwd: workspace,
        hasUI: false,
      });
      if (testCase.outcomes.local !== "pass") {
        assert.fail(`${testCase.id}: local Codex Edit unexpectedly succeeded`);
      }
      assert.deepEqual(await readSnapshot(workspace), testCase.expected);
      return "pass";
    } catch (error) {
      if (testCase.outcomes.local === "pass") throw error;
      assert.deepEqual(
        await readSnapshot(workspace),
        testCase.input,
        `${testCase.id}: failed Codex patch must not partially mutate the workspace`,
      );
      return "fail";
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export default async function () {
  const codexTool = await getCodexTool();
  const results = [];
  for (const testCase of comparisonCases) {
    const native = await runNativeCase(testCase);
    const codex = await runCodexCase(codexTool, testCase);
    results.push({ id: testCase.id, native, codex });
  }
  assert.equal(results.length, comparisonCases.length);
  assert.equal(results.filter(({ native }) => native === "pass").length, 5);
  assert.equal(results.filter(({ native }) => native === "fail").length, 2);
  assert.equal(results.filter(({ native }) => native === "unsupported").length, 5);
  assert.equal(results.filter(({ codex }) => codex === "pass").length, 7);
  assert.equal(results.filter(({ codex }) => codex === "fail").length, 5);
  for (const result of results) console.log(`${result.id}: native=${result.native}, codex=${result.codex}`);
  console.log(`Native edit vs local Codex Edit: ${results.length} comparison cases passed`);
}

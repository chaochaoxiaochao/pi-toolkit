import assert from "node:assert/strict";
import test from "node:test";
import { applyUpdate, parsePatch } from "../src/parser.ts";
import { comparisonCases } from "./comparison-cases.mjs";
import { runPatchCase } from "./comparison-harness.mjs";
import { applyLegacyUpdate, parseLegacyPatch } from "./legacy-parser-v0.1.7.mjs";

test("released v0.1.7 versus local parser over the growing comparison corpus", () => {
  const results = [];
  for (const testCase of comparisonCases) {
    const released = runPatchCase(
      testCase,
      parseLegacyPatch,
      applyLegacyUpdate,
      testCase.outcomes.released,
    );
    const local = runPatchCase(testCase, parsePatch, applyUpdate, testCase.outcomes.local);
    results.push({ id: testCase.id, released, local });
  }

  assert.equal(results.length, comparisonCases.length);
  assert.deepEqual(
    results.find(({ id }) => id === "repeated-update-same-path"),
    { id: "repeated-update-same-path", released: "fail", local: "pass" },
  );
  assert.equal(results.filter(({ released }) => released === "pass").length, 6);
  assert.equal(results.filter(({ released }) => released === "fail").length, 6);
  assert.equal(results.filter(({ local }) => local === "pass").length, 7);
  assert.equal(results.filter(({ local }) => local === "fail").length, 5);
  for (const result of results) console.log(`${result.id}: released=${result.released}, local=${result.local}`);
});

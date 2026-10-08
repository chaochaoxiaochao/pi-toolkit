import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { incidentCases } from "../benchmark/incident-cases.mjs";
import { interleaveNeutralAndChallenge } from "../benchmark/schedule.mjs";
import { applyUpdate, parsePatch } from "../src/parser.ts";
import { comparisonCases } from "./comparison-cases.mjs";
import { runPatchCase } from "./comparison-harness.mjs";

const manifest = JSON.parse(readFileSync(new URL("../benchmark/explicit-edit-100.json", import.meta.url), "utf8"));
const evidence = JSON.parse(readFileSync(new URL("../benchmark/results/explicit-edit-100-sol-low-v3.json", import.meta.url), "utf8"));

test("frozen 100-task selection keeps the same task IDs and fixture hashes", () => {
  assert.equal(manifest.included.length, 100);
  assert.equal(new Set(manifest.included.map(({ id }) => id)).size, 100);
  const digest = createHash("sha256")
    .update(manifest.included.map(({ id, fixtureSha256 }) => `${id}\0${fixtureSha256}`).sort().join("\n"))
    .digest("hex");
  assert.equal(digest, "3a5da55315806cfd7984264e6afb5f5b69739d2101b7128cb25ff35f834afc3b");
  assert.equal(evidence.completed, 300);
  assert.equal(evidence.results.length, 300);
  assert.equal(evidence.identities.focusedSelectionSha256, evidence.identities.taskManifestSha256);

  const outputDirectory = mkdtempSync(join(tmpdir(), "codex-edit-report-"));
  try {
    execFileSync(process.execPath, [new URL("./generate-test-report.mjs", import.meta.url).pathname], {
      env: { ...process.env, CODEX_EDIT_REPORT_DIR: outputDirectory, CODEX_EDIT_REPORT_SKIP_CHECKS: "1" },
      stdio: "pipe",
    });
    for (const filename of ["test-summary.md", "test-report.md", "test-report.html"]) {
      assert.equal(
        readFileSync(join(outputDirectory, filename), "utf8"),
        readFileSync(new URL(`../docs/${filename}`, import.meta.url), "utf8"),
        `${filename} must regenerate byte-for-byte from committed evidence`,
      );
    }
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("every five scheduled tasks contain four neutral and one challenge task", () => {
  assert.equal(manifest.selection.scheduling, "four-neutral-then-one-challenge-v1");
  for (let index = 0; index < manifest.included.length; index += 5) {
    const cohorts = manifest.included.slice(index, index + 5).map(({ cohort }) => cohort);
    assert.deepEqual(cohorts, ["neutral", "neutral", "neutral", "neutral", "challenge"]);
  }
  const budgetPrefix = manifest.included.slice(0, 47);
  assert.equal(budgetPrefix.filter(({ cohort }) => cohort === "neutral").length, 38);
  assert.equal(budgetPrefix.filter(({ cohort }) => cohort === "challenge").length, 9);
});

test("scheduler rejects malformed ratios and unknown cohorts", () => {
  assert.throws(() => interleaveNeutralAndChallenge([{ cohort: "neutral" }]), /Expected a 4:1/);
  assert.throws(() => interleaveNeutralAndChallenge([{ cohort: "incident" }]), /Unknown cohort/);
  assert.throws(() => interleaveNeutralAndChallenge([], 0), /positive integer/);
});

test("reported production incidents stay linked to executable protocol regressions", () => {
  assert.equal(incidentCases.length, 5);
  assert.equal(new Set(incidentCases.map(({ id }) => id)).size, incidentCases.length);
  assert.equal(incidentCases.filter(({ tier }) => tier === "agent-and-protocol").length, 4);
  assert.ok(incidentCases.some(({ tier }) => tier === "protocol-only"));

  const comparisonById = new Map(comparisonCases.map((testCase) => [testCase.id, testCase]));
  for (const incident of incidentCases) {
    const protocolCase = comparisonById.get(incident.protocolCaseId);
    assert.ok(protocolCase, `${incident.id} has no protocol regression`);
    assert.equal(protocolCase.kind, "valid-edit");
    assert.equal(runPatchCase(protocolCase, parsePatch, applyUpdate, "pass"), "pass");
    if (incident.tier === "agent-and-protocol") {
      assert.doesNotMatch(incident.prompt, /apply_patch|Update File|@@/i);
    }
  }
  assert.ok(incidentCases.some(({ protocolCaseId }) => comparisonById.get(protocolCaseId).outcomes.released === "fail"));
  assert.ok(incidentCases.some(({ protocolCaseId }) => comparisonById.get(protocolCaseId).outcomes.native !== "pass"));
});

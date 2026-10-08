#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const [runDirectoryArg, outputArg] = process.argv.slice(2);
if (!runDirectoryArg || !outputArg) {
  console.error("Usage: export-evidence.mjs <benchmark-run-directory> <output.json>");
  process.exit(2);
}

const runDirectory = resolve(runDirectoryArg);
const output = resolve(outputArg);
const packageDirectory = resolve(new URL("..", import.meta.url).pathname);
const [progress, runManifest, taskManifestText] = await Promise.all([
  readFile(resolve(runDirectory, "progress.json"), "utf8").then(JSON.parse),
  readFile(resolve(runDirectory, "manifest.json"), "utf8").then(JSON.parse),
  readFile(resolve(packageDirectory, "benchmark/explicit-edit-100.json"), "utf8"),
]);
const taskManifest = JSON.parse(taskManifestText);
const taskById = new Map(taskManifest.included.map((task) => [task.id, task]));
const sumAttempts = (result, field) => (result.recovery?.attempts ?? []).reduce(
  (sum, attempt) => sum + Number(attempt.execution?.[field] ?? 0), 0,
);

const evidence = {
  schemaVersion: 1,
  runId: basename(runDirectory),
  completed: progress.completed,
  total: progress.total,
  identities: {
    taskManifestSha256: createHash("sha256").update(taskManifestText).digest("hex"),
    focusedSelectionSha256: runManifest.focusedSelectionSha256,
    configSha256: runManifest.configSha256,
    verifierSha256: runManifest.verifierSha256,
  },
  source: taskManifest.source,
  selection: {
    seed: taskManifest.selection.seed,
    scheduling: taskManifest.selection.scheduling,
    neutral: taskManifest.included.filter((task) => task.cohort === "neutral").length,
    challenge: taskManifest.included.filter((task) => task.cohort === "challenge").length,
  },
  run: {
    contract: runManifest.contract,
    attempts: runManifest.attempts,
    oracleRecoveries: runManifest.oracleRecoveries,
    concurrency: runManifest.concurrency,
    timeoutMs: runManifest.timeoutMs,
  },
  harnesses: Object.fromEntries(Object.entries(runManifest.harnesses).map(([profile, harness]) => [profile, {
    agentVersion: harness.agentVersion,
    model: harness.model,
    thinking: harness.thinking,
    harnessVersion: harness.harnessVersion,
    configurationId: harness.configurationId,
    extensions: harness.configuration?.extensions ?? [],
  }])),
  results: progress.results.map((result) => ({
    taskId: result.taskId,
    profile: result.profile,
    category: result.category,
    cohort: taskById.get(result.taskId)?.cohort,
    firstAttemptPassed: Boolean(result.recovery?.firstAttemptPassed),
    eventuallyPassed: Boolean(result.recovery?.eventuallyPassed),
    recoveriesUsed: Number(result.recovery?.recoveriesUsed ?? 0),
    costUsd: sumAttempts(result, "costUsd"),
    totalTokens: sumAttempts(result, "totalTokens"),
    seconds: Number(result.seconds ?? 0),
    toolCalls: sumAttempts(result, "toolCalls"),
    failedToolCalls: sumAttempts(result, "failedToolCalls"),
    providerFailures: (result.recovery?.attempts ?? []).filter((attempt) => attempt.execution?.providerFailure).length,
  })),
};

await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(`Exported ${evidence.results.length} sanitized results to ${output}`);

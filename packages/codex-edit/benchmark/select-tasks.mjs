#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { interleaveNeutralAndChallenge } from "./schedule.mjs";

const SOURCE_COMMIT = "5827e3fb65845f4b76adb06e5919d94ec4ffd5cf";
const SEED = "pi-toolkit-codex-edit-100-v1";
const output = resolve("packages/codex-edit/benchmark/explicit-edit-100.json");
const sourceFlag = process.argv.indexOf("--source");
if (sourceFlag < 0 || !process.argv[sourceFlag + 1]) {
  throw new Error("Usage: node select-tasks.mjs --source /path/to/explicit-edit-benchmark");
}
const source = resolve(process.argv[sourceFlag + 1]);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
if (commit !== SOURCE_COMMIT) throw new Error(`Expected source ${SOURCE_COMMIT}, found ${commit}`);

const tasks = JSON.parse(
  execFileSync(process.execPath, ["scripts/list-tasks.mjs"], {
    cwd: source,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  }),
);
if (tasks.length !== 226) throw new Error(`Expected 226 source tasks, found ${tasks.length}`);

const neutralQuotas = new Map([
  ["language-replace", 13],
  ["language-select", 13],
  ["language-insert", 13],
  ["literal", 4],
  ["replace-all", 3],
  ["select-one", 3],
  ["unicode-fix", 3],
  ["unique", 2],
  ["multi-file", 2],
  ["select-subset", 2],
  ["delete-subset", 2],
  ["insert-subset", 2],
  ["distinct-edits", 2],
  ["replace-block", 2],
  ["delete-block", 2],
  ["move-block", 2],
  ["copy-block", 2],
  ["insert-block", 2],
  ["insert-payload", 2],
  ["copy-within", 2],
  ["move-between", 2],
]);

const challengeQuotas = new Map([
  ["select-one", 1],
  ["select-subset", 2],
  ["delete-subset", 1],
  ["insert-subset", 1],
  ["multi-file", 2],
  ["move-between", 2],
  ["distinct-edits", 2],
  ["replace-block", 1],
  ["delete-block", 1],
  ["move-block", 1],
  ["copy-block", 1],
  ["insert-block", 1],
  ["insert-payload", 1],
  ["copy-within", 1],
  ["literal", 1],
  ["unicode-fix", 1],
]);

const byCategory = new Map();
for (const task of tasks) {
  const group = byCategory.get(task.category) ?? [];
  group.push(task);
  byCategory.set(task.category, group);
}
if ([...neutralQuotas.values()].reduce((sum, count) => sum + count, 0) !== 80) {
  throw new Error("Neutral quotas must total 80");
}
if ([...challengeQuotas.values()].reduce((sum, count) => sum + count, 0) !== 20) {
  throw new Error("Challenge quotas must total 20");
}
if ([...byCategory.keys()].some((category) => !neutralQuotas.has(category))) {
  throw new Error("Neutral quotas do not cover every source category");
}

const rank = (label, task) =>
  createHash("sha256")
    .update(`${SEED}\0${label}\0${task.id}\0${task.fixtureSha256}`)
    .digest("hex");
const compareRank = (label) => (left, right) => rank(label, left).localeCompare(rank(label, right));

const neutral = [];
for (const [category, quota] of neutralQuotas) {
  const group = byCategory.get(category) ?? [];
  if (group.length < quota) throw new Error(`Insufficient neutral tasks in ${category}`);
  neutral.push(...group.toSorted(compareRank(`neutral:${category}`)).slice(0, quota));
}
const selectedIds = new Set(neutral.map((task) => task.id));

const challenge = [];
for (const [category, quota] of challengeQuotas) {
  const candidates = (byCategory.get(category) ?? [])
    .filter((task) => !selectedIds.has(task.id))
    .toSorted((left, right) =>
      right.scale - left.scale ||
      Number(right.variant === "unicode") - Number(left.variant === "unicode") ||
      compareRank(`challenge:${category}`)(left, right),
    );
  if (candidates.length < quota) throw new Error(`Insufficient challenge tasks in ${category}`);
  const chosen = candidates.slice(0, quota);
  challenge.push(...chosen);
  for (const task of chosen) selectedIds.add(task.id);
}

const entry = (task, cohort) => ({
  id: task.id,
  fixtureSha256: task.fixtureSha256,
  category: task.category,
  scale: task.scale,
  language: task.language,
  variant: task.variant,
  cohort,
  reasons: [{ profile: "pi-toolkit", reason: `${cohort}-cohort-v1` }],
});
const selected = [
  ...neutral.toSorted((left, right) => left.id.localeCompare(right.id)).map((task) => entry(task, "neutral")),
  ...challenge
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map((task) => entry(task, "challenge")),
];
const included = interleaveNeutralAndChallenge(selected);
if (included.length !== 100 || new Set(included.map(({ id }) => id)).size !== 100) {
  throw new Error("Selection must contain 100 unique tasks");
}

const excluded = tasks
  .filter((task) => !selectedIds.has(task.id))
  .toSorted((left, right) => left.id.localeCompare(right.id))
  .map((task) => ({
    id: task.id,
    fixtureSha256: task.fixtureSha256,
    reasons: [{ profile: "pi-toolkit", reason: "not-selected-v1" }],
  }));
const manifest = {
  version: 1,
  criterion: "frozen-proportional-80-plus-declared-challenge-20-v1",
  profiles: ["native-edit", "released-codex-edit", "local-codex-edit"],
  source: {
    repository: "https://github.com/alexshpunt/explicit-edit-benchmark",
    commit: SOURCE_COMMIT,
    taskCount: tasks.length,
  },
  selection: {
    seed: SEED,
    neutral: Object.fromEntries(neutralQuotas),
    challenge: Object.fromEntries(challengeQuotas),
    challengeOrdering: "descending scale, Unicode first, then seeded SHA-256 rank",
    scheduling: "four-neutral-then-one-challenge-v1",
  },
  included,
  excluded,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${output}: ${neutral.length} neutral + ${challenge.length} challenge`);

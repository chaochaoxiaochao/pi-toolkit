#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const [path, version, note, date = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
if (!path || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version ?? "") || !note || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("Usage: update-release-changelog.mjs <changelog> <version> <note> [YYYY-MM-DD]");
  process.exit(2);
}

const changelog = await readFile(path, "utf8");
if (!changelog.startsWith("## Unreleased\n")) {
  console.error(`${path} must start with an Unreleased section`);
  process.exit(1);
}
const released = changelog.replace(
  /^## Unreleased\n(?:\n)?/,
  `## ${date} - v${version}\n\n- ${note}\n`,
);
await writeFile(path, released, "utf8");

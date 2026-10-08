import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const children = [
  ["todo", "@maxiaochao/pi-todo", "extensions/todo.ts"],
  ["cache-export", "@maxiaochao/pi-cache-export", "extensions/cache-export.ts"],
  ["codex-edit", "@maxiaochao/pi-codex-edit", "extensions/codex-edit.ts"],
  ["herdr-subagents", "@maxiaochao/pi-herdr-subagents", "extensions/herdr-subagents.ts"],
  ["worktree", "@maxiaochao/pi-worktree", null],
];

assert.deepEqual(root.workspaces, ["packages/*"]);
for (const [slug, name, extension] of children) {
  const directory = join("packages", slug);
  for (const file of ["package.json", "README.md", "TESTING.md", "CHANGELOG.md"]) {
    assert.equal(existsSync(join(directory, file)), true, `${slug} missing ${file}`);
  }
  const media = slug === "herdr-subagents" ? ["docs/screenshot.png", "docs/demo.webm"] : ["docs/screenshot.png", "docs/demo.gif"];
  for (const file of media) {
    assert.equal(existsSync(join(directory, file)), true, `${slug} missing ${file}`);
  }
  const readme = readFileSync(join(directory, "README.md"), "utf8");
  assert.match(readme, /docs\/screenshot\.png/);
  if (slug === "herdr-subagents") {
    assert.equal(existsSync(join(directory, "docs/demo.gif")), false, "herdr-subagents must not ship docs/demo.gif");
    assert.match(readme, /github\.com\/user-attachments\/assets\/8ddf3ae6-a11a-492b-9cae-d9496ba65b67/);
    assert.match(readme, /docs\/demo\.webm/);
    assert.doesNotMatch(readme, /docs\/demo\.gif/);
  } else assert.match(readme, /docs\/demo\.gif/);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  assert.equal(manifest.name, name);
  assert.equal(manifest.repository.directory, directory);
  assert.equal(manifest.scripts?.test !== undefined, true, `${slug} missing test script`);
  assert.equal(manifest.files.includes("docs"), true, `${slug} does not publish docs media`);
  if (extension) assert.deepEqual(manifest.pi.extensions, [`./${extension}`]);
  assert.equal(root.files.includes(directory), true, `root tarball does not bundle ${slug}`);
}

assert.deepEqual(root.pi.extensions, [
  "./packages/todo/extensions/todo.ts",
  "./packages/cache-export/extensions/cache-export.ts",
  "./extensions/btw/index.ts",
  "./packages/codex-edit/extensions/codex-edit.ts",
  "./packages/herdr-subagents/extensions/herdr-subagents.ts",
]);
assert.equal(root.pi.skills.includes("./packages/worktree/skills"), true);
assert.equal(root.bin["pi-worktree"], "packages/worktree/bin/pi-worktree");

const releaseScript = readFileSync("scripts/release-package.sh", "utf8");
execFileSync("bash", ["-n", "scripts/release-package.sh"]);
assert.match(releaseScript, /git push --atomic origin main "\$CHILD_TAG" "\$ROOT_TAG"/);
assert.match(releaseScript, /git commit -m "release \$SLUG v\$\{CHILD_VERSION\} and toolkit v\$\{ROOT_VERSION\}"/);
assert.match(releaseScript, /npm pack "\.\/packages\/\$SLUG" --dry-run/);
assert.match(releaseScript, /update-release-changelog\.mjs/);
const releaseTestDirectory = mkdtempSync(join(tmpdir(), "release-changelog-"));
try {
  const changelog = join(releaseTestDirectory, "CHANGELOG.md");
  writeFileSync(changelog, "## Unreleased\n\n- existing change\n\n## 2026-01-01 - v1.0.0\n\n- old release\n");
  execFileSync(process.execPath, ["scripts/update-release-changelog.mjs", changelog, "1.0.1", "release note", "2026-10-08"]);
  assert.equal(
    readFileSync(changelog, "utf8"),
    "## 2026-10-08 - v1.0.1\n\n- release note\n- existing change\n\n## 2026-01-01 - v1.0.0\n\n- old release\n",
  );
} finally {
  rmSync(releaseTestDirectory, { recursive: true, force: true });
}
console.log("Package layout tests passed");

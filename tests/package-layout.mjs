import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  for (const file of ["docs/screenshot.png", "docs/demo.gif"]) {
    assert.equal(existsSync(join(directory, file)), true, `${slug} missing ${file}`);
  }
  const readme = readFileSync(join(directory, "README.md"), "utf8");
  assert.match(readme, /docs\/screenshot\.png/);
  assert.match(readme, /docs\/demo\.gif/);
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
console.log("Package layout tests passed");

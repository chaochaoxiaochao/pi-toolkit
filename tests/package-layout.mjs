import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const children = [
  ["todo", "@maxiaochao/pi-todo", "extensions/todo.ts", false],
  ["cache-export", "@maxiaochao/pi-cache-export", "extensions/cache-export.ts", true],
  ["codex-edit", "@maxiaochao/pi-codex-edit", "extensions/codex-edit.ts", true],
  ["herdr-subagents", "@maxiaochao/pi-herdr-subagents", "extensions/herdr-subagents.ts", true],
  ["scheduler", "@maxiaochao/pi-scheduler", "extensions/scheduler.ts", true],
  ["worktree", "@maxiaochao/pi-worktree", "extensions/worktree.ts", true],
];

assert.deepEqual(root.workspaces, ["packages/*"]);
for (const [slug, name, extension, bundled] of children) {
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
  assert.equal(root.files.includes(directory), bundled, `${slug} root bundle state is incorrect`);
}

assert.deepEqual(root.pi.extensions, [
  "./packages/cache-export/extensions/cache-export.ts",
  "./extensions/btw/index.ts",
  "./packages/codex-edit/extensions/codex-edit.ts",
  "./packages/herdr-subagents/extensions/herdr-subagents.ts",
  "./packages/scheduler/extensions/scheduler.ts",
  "./packages/worktree/extensions/worktree.ts",
]);
assert.equal(root.pi.skills.includes("./packages/worktree/skills"), true);
assert.equal(root.bin["pi-worktree"], "packages/worktree/bin/pi-worktree");

const agentTeamSkill = readFileSync("skills/agent-team/SKILL.md", "utf8");
const agentTeamModels = JSON.parse(readFileSync("skills/agent-team/models.json", "utf8"));
assert.match(agentTeamSkill, /每轮并发启动三个相互独立的子代理/);
assert.doesNotMatch(agentTeamSkill, /herdr_subagents|herdr\s+(?:pane|agent)/i);
assert.deepEqual(Object.keys(agentTeamModels).sort(), ["members", "roles"]);
assert.equal(agentTeamModels.members.length, 3);
assert.equal(new Set(agentTeamModels.members.map(({ name }) => name)).size, 3);
assert.equal(new Set(agentTeamModels.members.map(({ vendor }) => vendor)).size, 3);
assert.equal(new Set(agentTeamModels.members.map(({ model }) => model)).size, 3);
assert.equal(agentTeamModels.members.every((member) => !("role" in member) && !("charter" in member)), true);
assert.deepEqual(agentTeamModels.roles.map(({ name }) => name).sort(), ["adversary", "auditor", "replicator"]);
assert.equal(agentTeamModels.roles.every((role) => typeof role.charter === "string" && !("model" in role)), true);

const tapdSkill = readFileSync("skills/tapd/SKILL.md", "utf8");
const tapdAttachmentReference = readFileSync("skills/tapd/references/attachment-download.md", "utf8");
const tapdDownloadURLExtractor = "skills/tapd/scripts/extract-download-url.mjs";
assert.match(tapdSkill, /^---\nname: tapd\ndescription: .+tapd CLI.+tapd\.cn.+时使用。\n---\n/);
assert.match(tapdSkill, /tapd --help/);
assert.match(tapdSkill, /tapd <group> --help/);
assert.match(tapdSkill, /tapd <group> <command> --help/);
for (const command of [
  "tapd url '<tapd-url>'",
  "tapd workspace info",
  "tapd workspace list",
  "tapd story show <id>",
  "tapd bug show <id>",
  "tapd task show <id>",
  "tapd wiki show <id>",
  "tapd comment list --entry-id=<id> --entry-type=<stories|bug|tasks|wiki>",
  "tapd change list --entity-id=<id> --type=<story|bug|task>",
  "tapd attachment list --entry-id=<id> --type=<story|bug|task>",
  "tapd attachment download --id=<attachment-id>",
  "tapd image get --image-path=<path>",
  "tapd relation bugs --story-id=<id>",
  "tapd bug related-stories --bug-id=<id>",
  "tapd source list --object-id=<id> --type=<story|bug|task>",
  "tapd workitem-type list",
  "tapd workflow status-map --system=<story|bug> --workitem-type-id=<id>",
  "tapd workflow transitions --system=<story|bug> --workitem-type-id=<id>",
  "tapd <story|bug|task|wiki> create ...",
  "tapd <story|bug|task|wiki> update <id> ...",
  "tapd comment add --entry-id=<id> --entry-type=<stories|bug|tasks|wiki> --description='<text>'",
]) assert.match(tapdSkill, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(tapdSkill, /基础功能优先使用上表，不从完整命令树开始试错/);
assert.doesNotMatch(tapdSkill, /先用逐层 `--help`/);
assert.match(tapdSkill, /`tapd workspace list` 也不需要 workspace；`tapd workspace info` 和其他业务命令需要/);
assert.match(tapdSkill, /后续每条命令显式传 `--workspace-id=<id>`/);
assert.match(tapdSkill, /`attachment download` 和 `image get` 返回 JSON 下载描述/);
assert.match(tapdSkill, /不要用 `sed`、`grep` 或正则假设键的排版/);
assert.match(tapdSkill, /没有可用的图片读取或 OCR 能力时明确报告阻塞/);
assert.match(tapdSkill, /调查完成标准/);
assert.match(tapdSkill, /references\/attachment-download\.md/);
assert.doesNotMatch(tapdSkill, /## 命令参考|tapd testx case|tapd skill init/);
assert.match(tapdAttachmentReference, /scripts\/extract-download-url\.mjs/);
assert.match(tapdAttachmentReference, /curl --fail --location --retry 3/);
assert.match(tapdAttachmentReference, /--proto '=https' --proto-redir '=https'/);
assert.match(tapdAttachmentReference, /--output "\$PART" -- "\$URL"/);
assert.match(tapdAttachmentReference, /mv -- "\$PART" "\$OUTPUT"/);
assert.match(tapdAttachmentReference, /\[ -e "\$OUTPUT" \] \|\| \[ -e "\$PART" \]/);
assert.match(tapdAttachmentReference, /目标文件或 `.part` 已存在时必须在下载前失败/);
assert.match(tapdAttachmentReference, /不要假设列表一定包含大小字段/);
assert.match(tapdAttachmentReference, /本流程不续传失败的 `.part`/);
assert.equal(
  execFileSync(process.execPath, [tapdDownloadURLExtractor], {
    input: '{"download_url":"https://example.test/file.zip"}',
    encoding: "utf8",
  }),
  "https://example.test/file.zip\n",
);
for (const input of [
  "{}",
  '{"download_url":null}',
  '{"download_url":"http://example.test/file.zip"}',
  '{"download_url":"https://"}',
  '{"download_url":"https://user:password@example.test/file.zip"}',
  '{"download_url":"https://example.test/file.zip\\n"}',
]) {
  assert.throws(() => execFileSync(process.execPath, [tapdDownloadURLExtractor], { input, stdio: "pipe" }));
}

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
  const titledChangelog = join(releaseTestDirectory, "TITLED_CHANGELOG.md");
  writeFileSync(titledChangelog, "# Changelog\n\n## Unreleased\n\n- child change\n\n## 2026-01-01 - v1.0.0\n\n- old release\n");
  execFileSync(process.execPath, ["scripts/update-release-changelog.mjs", titledChangelog, "1.1.0", "child release", "2026-10-09"]);
  assert.equal(
    readFileSync(titledChangelog, "utf8"),
    "# Changelog\n\n## 2026-10-09 - v1.1.0\n\n- child release\n- child change\n\n## 2026-01-01 - v1.0.0\n\n- old release\n",
  );
} finally {
  rmSync(releaseTestDirectory, { recursive: true, force: true });
}
console.log("Package layout tests passed");

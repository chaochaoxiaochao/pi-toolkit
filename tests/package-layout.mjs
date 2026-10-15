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
  ["openai-account-pool", "@maxiaochao/pi-openai-account-pool", "extensions/openai-account-pool.ts", false],
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
  if (!bundled) {
    assert.equal(root.pi.extensions.some((entry) => entry.includes(`${directory}/`)), false, `${slug} must not be configured by the toolkit`);
    assert.equal(root.scripts["load-test"].includes(directory), false, `${slug} must not be load-tested by the toolkit`);
  }
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
assert.match(agentTeamSkill, /主 Agent.*负责核心调度/);
assert.match(agentTeamSkill, /\[models\.json\]\(models\.json\)/);
assert.match(agentTeamSkill, /按配置成员数并发启动子代理/);
assert.match(agentTeamSkill, /对应角色的 `charter` 放入任务/);
assert.match(agentTeamSkill, /配置为空或数量不匹配时，报告配置问题后再启动/);
assert.match(agentTeamSkill, /不是每次分析的必经步骤/);
assert.match(agentTeamSkill, /未决项写明缺失证据/);
assert.doesNotMatch(agentTeamSkill, /每轮并发启动三个|收尾前必须进行一轮|模型与角色不得永久绑定/);
assert.doesNotMatch(agentTeamSkill, /herdr_subagents|herdr\s+(?:pane|agent)/i);
assert.deepEqual(Object.keys(agentTeamModels).sort(), ["members", "roles"]);
assert.equal(agentTeamModels.members.length, 3);
assert.equal(new Set(agentTeamModels.members.map(({ name }) => name)).size, 3);
assert.equal(new Set(agentTeamModels.members.map(({ vendor }) => vendor)).size, 3);
assert.equal(new Set(agentTeamModels.members.map(({ model }) => model)).size, 3);
assert.equal(agentTeamModels.members.every((member) => !("role" in member) && !("charter" in member)), true);
assert.deepEqual(agentTeamModels.roles.map(({ name }) => name).sort(), ["adversary", "auditor", "replicator"]);
assert.equal(agentTeamModels.roles.every((role) => typeof role.charter === "string" && !("model" in role)), true);
assert.equal(agentTeamModels.members.length, agentTeamModels.roles.length);
for (const { name, charter } of agentTeamModels.roles) {
  assert.equal(agentTeamSkill.includes(`\`${name}\``), false, `role ${name} must be defined only in models.json`);
  assert.equal(agentTeamSkill.includes(charter), false, `role ${name} charter must not be duplicated in SKILL.md`);
}

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
assert.match(tapdAttachmentReference, /set -euo pipefail/);
assert.match(tapdAttachmentReference, /curl --fail --location --retry 3/);
assert.match(tapdAttachmentReference, /--proto '=https' --proto-redir '=https'/);
assert.match(tapdAttachmentReference, /--output "\$PART" -- "\$URL"/);
assert.match(tapdAttachmentReference, /mv -- "\$PART" "\$OUTPUT"/);
assert.match(tapdAttachmentReference, /\[ -e "\$OUTPUT" \] \|\| \[ -e "\$PART" \]/);
assert.match(tapdAttachmentReference, /目标文件或 `.part` 已存在时必须在下载前失败/);
assert.match(tapdAttachmentReference, /附件大小未知或大于 50 MB 时，工具超时至少设为 600 秒/);
assert.match(tapdAttachmentReference, /timeout 仅表示本地执行被终止/);
assert.match(tapdAttachmentReference, /删除残留 `.part`，重新获取临时 URL后从头下载|删除残留 `.part`，重新获取临时 URL 后从头下载/);
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
assert.match(releaseScript, /\.\/scripts\/release-check\.sh "\$SLUG"/);
assert.ok(releaseScript.indexOf("npm version") < releaseScript.indexOf('./scripts/release-check.sh "$SLUG"'), "child release checks must exercise final versions");
assert.match(releaseScript, /trap rollback_release_metadata ERR/);
assert.match(releaseScript, /release checks changed unexpected file/);
assert.match(releaseScript, /update-release-changelog\.mjs/);
assert.match(releaseScript, /CHANGELOG\.md "\$ROOT_VERSION" "\$SLUG v\$CHILD_VERSION: \$NOTE"/, "the root release note must not claim every child is bundled");
const rootReleaseScript = readFileSync("scripts/release.sh", "utf8");
const releaseCheckScript = readFileSync("scripts/release-check.sh", "utf8");
const publishIfNeededScript = readFileSync("scripts/publish-if-needed.sh", "utf8");
const publishWorkflow = readFileSync(".github/workflows/publish.yml", "utf8");
for (const script of ["scripts/release.sh", "scripts/release-check.sh", "scripts/publish-if-needed.sh"]) execFileSync("bash", ["-n", script]);
assert.match(rootReleaseScript, /\.\/scripts\/release-check\.sh/);
assert.match(rootReleaseScript, /git push --atomic origin main "v\$\{VERSION\}"/);
assert.ok(rootReleaseScript.indexOf("npm version") < rootReleaseScript.indexOf("./scripts/release-check.sh"), "root release checks must exercise the final version");
assert.match(rootReleaseScript, /trap rollback_release_metadata ERR/);
assert.match(rootReleaseScript, /git add package\.json CHANGELOG\.md/);
assert.match(rootReleaseScript, /release checks changed unexpected file/);
assert.match(releaseCheckScript, /npm run test:root/);
assert.match(releaseCheckScript, /npm run load-test:root/);
assert.match(releaseCheckScript, /run npm --prefix "\$PACKAGE_DIR" test/);
assert.match(releaseCheckScript, /has_package_script "\$PACKAGE_DIR" load-test/);
assert.match(releaseCheckScript, /run npm pack "\.\/\$PACKAGE_DIR" --dry-run/);
assert.match(releaseCheckScript, /npm --prefix packages\/herdr-subagents run test:real-herdr/);
assert.match(releaseCheckScript, /if \[\[ "\$SLUG" == herdr-subagents \]\]/);
assert.match(releaseCheckScript, /git diff --quiet "\$BASE_TAG" -- packages\/herdr-subagents/);
assert.match(releaseCheckScript, /npm pack --dry-run/);
assert.match(publishIfNeededScript, /npm view "\$NAME@\$VERSION" version/);
assert.match(publishIfNeededScript, /npm publish/);
assert.equal(existsSync(".github/workflows/publish-package.yml"), false);
assert.match(publishWorkflow, /tags:\s*\n\s*- "v\*"/);
assert.doesNotMatch(publishWorkflow, /npm test|npm run load-test|release-check\.sh|Install test runtime/);
assert.match(publishWorkflow, /\.\/scripts\/publish-if-needed\.sh "\$PACKAGE_DIR"/);
assert.match(publishWorkflow, /\.\/scripts\/publish-if-needed\.sh \./);
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
  const releasedChangelog = join(releaseTestDirectory, "RELEASED_CHANGELOG.md");
  writeFileSync(releasedChangelog, "## 2026-01-01 - v1.0.0\n\n- old release\n");
  execFileSync(process.execPath, ["scripts/update-release-changelog.mjs", releasedChangelog, "1.0.1", "release note", "2026-10-10"]);
  assert.equal(
    readFileSync(releasedChangelog, "utf8"),
    "## 2026-10-10 - v1.0.1\n\n- release note\n\n## 2026-01-01 - v1.0.0\n\n- old release\n",
  );
  const titledReleasedChangelog = join(releaseTestDirectory, "TITLED_RELEASED_CHANGELOG.md");
  writeFileSync(titledReleasedChangelog, "# Changelog\n\n## 2026-01-01 - v1.0.0\n\n- old release\n");
  execFileSync(process.execPath, ["scripts/update-release-changelog.mjs", titledReleasedChangelog, "1.1.0", "child release", "2026-10-11"]);
  assert.equal(
    readFileSync(titledReleasedChangelog, "utf8"),
    "# Changelog\n\n## 2026-10-11 - v1.1.0\n\n- child release\n\n## 2026-01-01 - v1.0.0\n\n- old release\n",
  );
} finally {
  rmSync(releaseTestDirectory, { recursive: true, force: true });
}
console.log("Package layout tests passed");

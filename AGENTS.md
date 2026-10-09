# Global Agent Notes

Issues are tracked in GitHub Issues; see `docs/agents/issue-tracker.md`. Use the five default triage labels from `docs/agents/triage-labels.md`. Domain language lives in `docs/agents/domain.md`.

本仓库是 `pi-toolkit` npm workspace 的源码与发布工程。

## 模块与目录

```text
pi-toolkit/
├── package.json                 # 主组合包；workspaces = packages/*
├── extensions/
│   └── btw/                     # 主包独有实现与测试
├── packages/
│   ├── todo/                    # @maxiaochao/pi-todo 权威源码
│   ├── cache-export/            # @maxiaochao/pi-cache-export 权威源码
│   ├── codex-edit/              # @maxiaochao/pi-codex-edit 权威源码
│   ├── herdr-subagents/         # @maxiaochao/pi-herdr-subagents 权威源码
│   ├── scheduler/               # @maxiaochao/pi-scheduler 权威源码
│   └── worktree/                # @maxiaochao/pi-worktree：bin + completion + skill
├── skills/                      # 主包独有的通用 skills
├── themes/nightowl.json
├── global/AGENTS.md             # 安装到 ~/.pi/agent/AGENTS.md 的权威源
├── scripts/release.sh           # 主包发布
├── scripts/release-package.sh   # 子包 + 主包同 commit 联动发布器
└── .github/workflows/
    ├── publish.yml              # vX.Y.Z → 主包
    └── publish-package.yml      # <slug>-vX.Y.Z → 对应子包
```

## 组织原则

- `packages/*` 是子包功能实现的单一源码；根 manifest 直接加载默认启用子包的路径，不设置 wrapper。`extensions/` 只放主包独有的 BTW。
- 主包 tarball 直接包含默认启用子包的运行源码，不依赖 npm 上的子包版本，因此主包与子包可以独立发版。Todo 不在根 tarball 或默认 loadout 中。
- 用户在完整工具包和已内嵌的独立子包之间二选一；同时安装可能重复注册 extension、skill 或 bin。Todo 是例外，可以与完整工具包一起安装。
- BTW 保留在主包，不发布子包。
- 每个子包必须包含 `package.json`、`README.md`、`TESTING.md`、`CHANGELOG.md`、确定性测试，以及适合该包的加载或集成检查。
- 每个子包 README 必须说明功能、来源/设计动机、安装与更新、可复制示例，并引用真实实现生成的媒体。除 Herdr Subagents 外，每个子包包含 `docs/screenshot.png` 和 `docs/demo.gif`；Herdr Subagents 包含 `docs/screenshot.png` 和完整的 `docs/demo.webm`，README 通过 GitHub attachment URL 直接显示视频，不保留 GIF。执行 `node scripts/capture-package-media.mjs` 统一重生成媒体并进入 tarball。

## 开发与验证

- 修改子包时先运行 `npm --prefix packages/<slug> test`，再运行其 README/TESTING 指定的 load test 和 `npm pack ./packages/<slug> --dry-run`。
- 运行 `node scripts/capture-package-media.mjs` 后通过 `docs/package-media-gallery.html` 检查全部真实截图与动画；完整验收结果记录在 `docs/verification.md`。
- 修改根入口、BTW、主题、全局指令或组合清单时运行 `npm test`、`npm run load-test` 和根目录 `npm pack --dry-run`。
- Codex Edit 必须加载 `packages/codex-edit/extensions/codex-edit.ts`；parser/matcher 改动必须覆盖重复 HTML/Markdown 区域、同路径多 update、多 hunk、多文件 patch，以及空 chunk、stale context 和冲突路径的安全失败。每个新生产问题先加入 `tests/comparison-cases.mjs`，且 native/released 两组对比都必须通过。`npm --prefix packages/codex-edit test` 必须从测试结果生成 `docs/test-report.md`，再转换为自包含 `docs/test-report.html`；提交和发版必须包含最新报告。冻结的 released baseline 保持不变。
- Herdr Subagents 必须运行全部确定性测试、加载 `packages/herdr-subagents/extensions/herdr-subagents.ts`，并在真实 Herdr 中验证只读并发批次和 tab 清理；媒体必须通过 `HERDR_MEDIA_WINDOW_ID=<window-id> node scripts/capture-package-media.mjs` 录制父 Pi 对话、逐一聚焦三个真实 Agent pane 和最终父会话结果，同时保留截图和完整 WebM 视频。
- Scheduler 必须运行确定性 fake-clock 与 extension 集成测试、加载 `packages/scheduler/extensions/scheduler.ts`，并验证定时/手动触发统一使用 followUp、同一 schedule 最多积压一次、取消与 session shutdown 清理 timer；媒体展示真实核心状态机输出。
- Cache Export 的发布验收要求确定性测试通过，并在有 Chrome 的环境中跑浏览器 E2E；skip 不算发布验收通过。
- `packages/cache-export/src/tau-assets.ts` 来自 `huggingface/tau` 的 `session_usage.py`，只能重生成，不能手改。
- Herdr Subagents 的实现可能存在并行工作；重构 package 接线时保留其未提交实现改动。
- Worktree 包同时拥有 CLI、Extension、completion、postinstall 与 skill；CLI 是 Git 操作的唯一实现，Extension 的 command/tool 必须复用 `prepare --json`，不能只同步其中一层。
- 扩展依赖 Pi 内置包时放 `peerDependencies`（`@earendil-works/pi-*`、`typebox`），不要安装实体副本。
- 不用 `.mjs` 写扩展入口；Pi `/reload` 对 `.ts/.js` 使用 jiti，Node 原生 `.mjs` 缓存不会刷新。

## Skill 与文档约束

- 用户可见行为变化必须同步检查根 `README.md`、本文件、根 `CHANGELOG.md`、相关子包 README/TESTING/CHANGELOG 和 manifest。
- `skills/herdr/SKILL.md` 只在同步上游稳定 tag 时整体替换；唯一允许的本地差异是 description 与 H1 中的名称小写化，来源见 NOTICE。
- `skills/tapd/` 由本仓库独立维护，不使用 `tapd skill init` 的生成结果覆盖；主文件保留工作流与跨版本契约，附件等分支细节放在 `references/`，具体命令语法由运行时 `tapd --help` 及逐层子命令帮助提供。
- `web-browser` 改动后检查全部 `scripts/*.js` 语法、实际启动隔离浏览器并完成导航/求值，再检查 tarball。

## 两层 AGENTS

| 文件 | 范围 | 安装方式 |
|---|---|---|
| `global/AGENTS.md` | 所有项目的个人行为准则 | 主包 postinstall 复制到 `~/.pi/agent/AGENTS.md` |
| 根 `AGENTS.md` | 本仓库开发与发布 | Pi 在仓库中自动发现 |

修改 `global/AGENTS.md` 后可运行 `bash scripts/install.sh` 同步本机。

## 安装模型

完整安装：

```bash
pi install npm:@maxiaochao/pi-toolkit
```

完整工具包默认不启用 Todo；需要进度 UI 时单独安装 `npm:@maxiaochao/pi-todo`。

按需单独安装：

```bash
pi install npm:@maxiaochao/pi-todo
pi install npm:@maxiaochao/pi-cache-export
pi install npm:@maxiaochao/pi-codex-edit
pi install npm:@maxiaochao/pi-herdr-subagents
pi install npm:@maxiaochao/pi-scheduler
pi install npm:@maxiaochao/pi-worktree
```

## 发布

主包：

```bash
./scripts/release.sh <patch|minor|major> "<note>"
```

子包修改统一使用联动发布：

```bash
./scripts/release-package.sh <todo|cache-export|codex-edit|herdr-subagents|scheduler|worktree> <initial|patch|minor|major> "<note>" [主包 patch|minor|major]
```

- 主包 tag 为 `vX.Y.Z`，由 `.github/workflows/publish.yml` 发布。
- 子包 tag 为 `<slug>-vX.Y.Z`，统一由 `.github/workflows/publish-package.yml` 解析目录、校验版本、测试、打包并发布。
- 子包联动发布会先完成全部测试与两个 tarball 检查，在同一个 commit 更新子包和主包的版本及 CHANGELOG，创建两个 tag，再通过 `git push --atomic` 一次推送；主包版本级别默认为 `patch`。
- 发布只通过 tag 触发 CI；不要在本地执行 `npm publish`。
- 不要只发布子包 tag：完整工具包内嵌子包源码，必须由上述联动脚本同时发布新的主包版本；`pi update npm:@maxiaochao/pi-toolkit` 只会获取已发布的新根包。
- 所有包可共用 `NPM_TOKEN`，但版本和 tag 相互独立。

更新命令：

```bash
pi update --extensions                    # 更新所有已安装包
pi update npm:@maxiaochao/pi-toolkit
pi update npm:@maxiaochao/pi-todo
pi update npm:@maxiaochao/pi-cache-export
pi update npm:@maxiaochao/pi-codex-edit
pi update npm:@maxiaochao/pi-herdr-subagents
pi update npm:@maxiaochao/pi-scheduler
pi update npm:@maxiaochao/pi-worktree
```

## 迁移遗留

- 删除旧全局扩展 `~/.pi/agent/extensions/todo.ts`，避免重复注册。
- 从项目 `.pi/settings.json` 移除旧的 `../pi-cache-dashboard` 并删除该目录。

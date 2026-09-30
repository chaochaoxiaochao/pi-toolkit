# Global Agent Notes

## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

本仓库是个人 pi 扩展包 `pi-toolkit` 的**源码与发布工程**。任何改动请遵循以下规则。

## 目录结构

```
pi-toolkit/
├── package.json            # pi manifest：声明扩展、skills、themes 与运行依赖
├── global/AGENTS.md        # ★ 全局个人指令的权威源（见下方“全局 AGENTS 安装”）
├── extensions/
│   ├── todo.ts             # todo 工具、活跃任务 widget 与 /todos 历史视图
│   ├── todo-state.ts       # todo 状态机、迁移与自动推进纯逻辑
│   ├── btw.ts              # /btw 独立侧聊会话
│   ├── btw-scroll.ts       # BTW transcript 滚动边界与分页步长纯逻辑
│   ├── tests/              # todo、BTW 等根扩展的轻量确定性测试
│   ├── cache-export/       # /cache_export 交互式缓存仪表盘
│   │   ├── index.ts        # 入口：注册命令、输出路径、WSL 打开
│   │   ├── render.ts       # 聚合 + miss/streak 规则 + HTML 渲染（改逻辑在这里）
│   │   ├── tau-assets.ts   # tau 原版 CSS/JS 资产（勿手改，重生成，见下）
│   │   └── tests/          # 确定性测试（阈值边界、规则路径、退化输入）
│   └── codex-edit/         # 根包加载入口，复用 packages/codex-edit 的实现
├── skills/
│   ├── html-artifact/     # 复杂说明的自包含 HTML artifact skill
│   ├── web-browser/       # Chrome/Chromium CDP 自动化（含 WSL Windows Chrome 支持）
│   ├── show-me/           # 用图/伪代码/HTML 直观解释当前话题（源自 humanlayer/skills，MIT）
│   ├── pi-worktree/       # pi-worktree CLI 的 worktree 增删改查用法（隔离任务时用）
│   ├── chrome-cdp/        # 附加到已开调试端口的 live Chrome（源自 pasky/chrome-cdp-skill，MIT）
│   ├── pdlog/             # 解压和查看普渡 .pdlog 日志（自带 ppmd 解压二进制）
│   ├── herdr/             # 控制 Herdr 终端复用器（拷贝自 herdrdev/herdr v0.9.1，仅小写化 skill 名，Apache-2.0）
│   ├── tapd/              # TAPD CLI 用法（需求/缺陷/任务/Wiki 等，用 `tapd skill init` 重新生成）
│   └── calldiff/          # 跨 commit 的调用栈 diff（逐字节拷贝自 tanishqkancharla/calldiff，MIT）
├── themes/nightowl.json   # 随包发布的 Night Owl 主题
├── bin/                   # 独立 shell 命令（postinstall 拷到 ~/.local/bin）
│   ├── pi-worktree        # worktree 创建/进入/合并/清理一条龙包装
│   └── pi-worktree-completion.bash  # bash 补全（装到 ~/.local/share/bash-completion）
├── packages/herdr-subagents/ # 独立 npm 包：herdr_subagents Pi 扩展
├── packages/codex-edit/     # 独立 npm 包：GPT/Codex apply_patch Pi 扩展 + docs
├── scripts/release.sh      # 根包一键发布（测试→版本→tag→推→publish）
├── scripts/release-herdr-subagents.sh # Herdr Subagents 包独立发布
├── scripts/release-codex-edit.sh # codex-edit 包独立发布
└── .github/workflows/      # 三个包各自的 npm 发布 workflow
```

## 开发规则

- **改扩展逻辑**：根扩展改完必须跑 `npm test`（根包确定性测试），再做 `npm run load-test`；Herdr Subagents 包改完必须跑 `npm --prefix packages/herdr-subagents test`，再加载 `packages/herdr-subagents/extensions/herdr-subagents.ts`；涉及 Herdr 调度、导航、恢复时还要在 Herdr 内做只读并发批次、pane 聚焦、tab 清理和历史 session 恢复冒烟，配置与运行状态分别使用 `.pi/herdr-subagents.json` 和 `.pi/herdr-subagents/`；codex-edit 的权威实现位于 `packages/codex-edit`，改完必须跑 `npm --prefix packages/codex-edit test`、`npm pack --dry-run`，再分别加载独立入口和 `extensions/codex-edit/index.ts` 根包入口。
- **文档同步**：新增或变更用户可见功能时，必须同步检查 `README.md`、根 `AGENTS.md`、`CHANGELOG.md` 和 `package.json` manifest；提交前用 `rg` 搜索旧的功能清单、目录说明和版本信息，确认没有过时描述。
- **改 skill**：先按目标 skill 的 `SKILL.md` 验证脚本；`web-browser` 至少要检查全部 `scripts/*.js` 语法、实际启动隔离浏览器、完成一次导航/求值，并用 `npm pack --dry-run` 确认 skill 文件进入 tarball。WSL 下应验证 Windows Chrome 自动发现和 PowerShell 启动路径。
- **skill 运行依赖**：第三方依赖统一声明在根 `package.json` 的 `dependencies`，不要提交 skill 内的 `node_modules`；Pi 从 npm/git 安装包时会执行 `npm install`。Pi 内置包仍按下条规则放 `peerDependencies`。
- **不改 `tau-assets.ts`**：该文件从 `huggingface/tau` 的 `src/tau_coding/session_usage.py` 提取（USAGE_STYLES / USAGE_SCRIPT），保证与上游逐字节一致。需要更新时用提取脚本重生成，不要手改。
- **`skills/herdr/SKILL.md` 只在同步上游时动**：与 `LICENSE` 一起从 `herdrdev/herdr` 的稳定 tag 拷贝（来源与更新方式见 `skills/herdr/NOTICE`）。目前**唯一**的本地改动是把 description 与 H1 里的 `Herdr` 小写成 `herdr`，其余逐字节一致；同步新 tag 时先整体替换两个文件、改 NOTICE 里的 tag，再重放这处小写化，不要加别的改动。
- **不改 `skills/calldiff/SKILL.md`**：与 `LICENSE` 一起从 `tanishqkancharla/calldiff` 的 main commit 逐字节拷贝（上游没有 release tag，来源与更新方式见 `skills/calldiff/NOTICE`）。需要更新时整体替换这两个文件并改 NOTICE 里的 commit，不要手改内容。
- **`skills/tapd/SKILL.md` 由 `tapd skill init` 生成，但带一节本地补充**：`#### 安全下载附件`（临时 URL 续传与完整性校验流程）是手写的，重新生成会丢掉，重生成后必须重放这一节；其余内容保持生成原样。
- **别用 `.mjs` 放扩展代码**：pi 的 `/reload` 走 jiti（moduleCache:false），只对 `.ts/.js` 生效；`.mjs` 走 Node 原生 ESM 缓存，reload 刷不掉，会导致“改了不生效”。
- 扩展依赖 pi 内置包时写进 `peerDependencies`（`@earendil-works/pi-*`、`typebox`），不要实装。

**两层 AGENTS 的区别**

| 文件 | 作用范围 | 装载点 |
|---|---|---|
| `global/AGENTS.md`（仓库内） | 所有项目（个人行为准则） | 拷到 `~/.pi/agent/AGENTS.md`，pi 启动自动加载 |
| `AGENTS.md`（仓库根） | 仅本仓库（开发/发版规则） | pi 进本目录自动发现 |

改 `global/AGENTS.md` 后重跑 `bash scripts/install.sh` 即可同步到全局（用拷贝而非软链，保持运行不依赖仓库目录）。

## 打包发布

### 前置条件（首次）

1. GitHub 建仓并关联：
   ```bash
   gh auth login                     # 未登录时
   gh repo create pi-toolkit --private --source . --remote origin --push
   # 或旧方式： git remote add origin git@github.com:<你>/pi-toolkit.git && git push -u origin main
   ```
2. package.json 的 `repository.url` 改成真实地址（占位符 `<YOUR-GITHUB-USER>`）。
3. 在 GitHub 仓库 Actions Secrets 中配置 `NPM_TOKEN`（见下文）。

### 发布流程（每次发版）

1. `./scripts/release.sh <patch|minor|major> "<changelog note>"`：本地跑测试 + 升版本（如 `v0.1.5`）＋写 CHANGELOG＋commit＋打 tag＋推 main 和 tag。
2. tag push 自动触发 GitHub Actions（`.github/workflows/publish.yml`）发布到 npm，这是唯一发布通道。
   - 前提：仓库 Secrets 里配好了 `NPM_TOKEN`（npm 的 granular access token + **Bypass 2FA**）。
   - CI 会校验 tag 与 `package.json` 版本一致，再运行测试和 `npm publish`。

手动等价流程同样必须先更新版本和 CHANGELOG，再推送精确 tag；不要在本地执行 `npm publish`。

### 独立 Herdr Subagents 包发布

`packages/herdr-subagents` 是完全独立的包；`packages/codex-edit` 既是 Codex Edit 的权威实现和独立子包，也由根包通过 `extensions/codex-edit/index.ts` 默认加载。三个包可分别安装和升级：

```bash
pi install npm:@maxiaochao/pi-toolkit
pi install npm:@maxiaochao/pi-herdr-subagents
pi install npm:@maxiaochao/pi-codex-edit
```

三个包使用独立版本号和 tag：

| 包 | 版本来源 | 发布 tag | 发布 workflow |
|---|---|---|---|
| `@maxiaochao/pi-toolkit` | 根目录 `package.json` | `vX.Y.Z` | `.github/workflows/publish.yml` |
| `@maxiaochao/pi-herdr-subagents` | `packages/herdr-subagents/package.json` | `herdr-subagents-vX.Y.Z` | `.github/workflows/publish-herdr-subagents.yml` |
| `@maxiaochao/pi-codex-edit` | `packages/codex-edit/package.json` | `codex-edit-vX.Y.Z` | `.github/workflows/publish-codex-edit.yml` |

Herdr Subagents 包首次发版（使用当前 `0.1.0` 版本）：
```bash
./scripts/release-herdr-subagents.sh initial "initial release"
```

后续发版：
```bash
./scripts/release-herdr-subagents.sh <patch|minor|major> "<changelog note>"
```

该脚本只运行 Herdr Subagents 包测试和扩展加载检查，只修改该包版本及 CHANGELOG，并且只暂存 `packages/herdr-subagents`。它创建 `herdr-subagents-vX.Y.Z` tag 并推送；tag push 后由专用 GitHub Actions 校验版本、运行测试并执行 npm publish。不要用根目录 `scripts/release.sh` 发布 Herdr Subagents 包，也不要在本地执行 `npm publish`。

根包的 `vX.Y.Z`、Herdr Subagents 包的 `herdr-subagents-vX.Y.Z` 和 codex-edit 包的 `codex-edit-vX.Y.Z` 互不触发彼此 workflow；三个包可以共用仓库和 `NPM_TOKEN`，但 npm 版本号、发布 tag 和 CI 发布步骤彼此独立。

### 独立 codex-edit 包发布

`packages/codex-edit` 作为独立子包发布为 `@maxiaochao/pi-codex-edit`，同时也是根包内置 Codex Edit 的单一源码。后续发布使用：

```bash
./scripts/release-codex-edit.sh <patch|minor|major> "<changelog note>"
```

该脚本只测试、打包和发布独立子包，并创建 `codex-edit-vX.Y.Z` tag；它不会发布根包。`packages/codex-edit` 的实现或配置有改动时，必须再运行 `./scripts/release.sh <patch|minor|major> "<changelog note>"` 发布新的根包版本，根包用户执行 `pi update npm:@maxiaochao/pi-toolkit` 后才会收到更新。不要在本地执行 `npm publish`。用户应在完整工具包和独立子包之间二选一，避免重复注册 `apply_patch`。

### 首次启用自动发布（一次性）

1. npm 网页生成 token：`https://www.npmjs.com/settings/<你>/tokens` → Generate New Token → **Granular Access Token** → 勾 **Bypass 2FA** → 权限 Packages Read and write。
2. 存进 GitHub 仓库 Secrets：Settings → Secrets and variables → Actions → New secret → 名字 `NPM_TOKEN`。

### 更新已装机器的包

```bash
pi update npm:@maxiaochao/pi-toolkit      # 更新根包及其内置 Codex Edit
pi update npm:@maxiaochao/pi-herdr-subagents # 更新 Herdr Subagents 包
pi update npm:@maxiaochao/pi-codex-edit    # 仅更新独立 Codex Edit 子包
```

## 回滚

- **npm 侧**：`npm unpublish pi-toolkit@<坏版本>`（24h 内）或 `npm deprecate pi-toolkit@<坏版本> "broken, use X"`。
- **装包侧**：`pi install npm:@maxiaochao/pi-toolkit@<上一个好版本>` 或 `pi remove npm:@maxiaochao/pi-toolkit`。

## 迁移遗留的清理步骤（已装过旧版时）

- 删除全局旧扩展文件：`rm ~/.pi/agent/extensions/todo.ts`（避免与新包双注册）。
- 删除项目级旧包：把项目 `.pi/settings.json` 里 `"../pi-cache-dashboard"` 移除，删掉 `pi-cache-dashboard/` 目录。

# Global Agent Notes

本仓库是个人 pi 扩展包 `pi-toolkit` 的**源码与发布工程**。任何改动请遵循以下规则。

## 目录结构

```
pi-toolkit/
├── package.json            # pi manifest：pi.extensions 声明两个扩展入口
├── global/AGENTS.md        # ★ 全局个人指令的权威源（见下方“全局 AGENTS 安装”）
├── extensions/
│   ├── todo.ts             # /todos 扩展（来源于 ~/.pi/agent/extensions/todo.ts）
│   └── cache-export/       # /cache_export 交互式缓存仪表盘
│       ├── index.ts        # 入口：注册命令、输出路径、WSL 打开
│       ├── render.ts       # 聚合 + miss/streak 规则 + HTML 渲染（改逻辑在这里）
│       ├── tau-assets.ts   # tau 原版 CSS/JS 资产（勿手改，重生成，见下）
│       └── tests/          # 确定性测试（阈值边界、规则路径、退化输入）
├── packages/tiny-subagent/  # 独立 npm 包：tiny_subagents Pi 扩展
├── scripts/release.sh      # 根包一键发布（测试→版本→tag→推→publish）
├── scripts/release-tiny-subagent.sh # tiny 包独立发布
└── .github/workflows/      # 两个包各自的 npm 发布 workflow
```

## 开发规则

- **改扩展逻辑**：根扩展改完必须跑 `npm test`（根包确定性测试），再做 `npm run load-test`；tiny 包改完必须跑 `npm test --prefix packages/tiny-subagent`，再加载 `packages/tiny-subagent/extensions/tiny-subagent.ts`。
- **不改 `tau-assets.ts`**：该文件从 `huggingface/tau` 的 `src/tau_coding/session_usage.py` 提取（USAGE_STYLES / USAGE_SCRIPT），保证与上游逐字节一致。需要更新时用提取脚本重生成，不要手改。
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

### 独立 tiny subagent 包发布

`packages/tiny-subagent` 是独立 npm 包 `@maxiaochao/pi-tiny-subagent`，不属于根包 `@maxiaochao/pi-toolkit` 的 `pi.extensions`，两个包分别安装和升级：

```bash
pi install npm:@maxiaochao/pi-toolkit
pi install npm:@maxiaochao/pi-tiny-subagent
```

两套包使用独立版本号和 tag：

| 包 | 版本来源 | 发布 tag | 发布 workflow |
|---|---|---|---|
| `@maxiaochao/pi-toolkit` | 根目录 `package.json` | `vX.Y.Z` | `.github/workflows/publish.yml` |
| `@maxiaochao/pi-tiny-subagent` | `packages/tiny-subagent/package.json` | `tiny-subagent-vX.Y.Z` | `.github/workflows/publish-tiny-subagent.yml` |

tiny 包首次发版（使用当前 `0.1.0` 版本）：
```bash
./scripts/release-tiny-subagent.sh initial "initial release"
```

后续发版：
```bash
./scripts/release-tiny-subagent.sh <patch|minor|major> "<changelog note>"
```

该脚本只运行 tiny 包测试和扩展加载检查，只修改 tiny 包版本及 CHANGELOG，并且只暂存 `packages/tiny-subagent`。它创建 `tiny-subagent-vX.Y.Z` tag 并推送；tag push 后由专用 GitHub Actions 校验版本、运行测试并执行 npm publish。不要用根目录 `scripts/release.sh` 发布 tiny 包，也不要在本地执行 `npm publish`。

根包的 `vX.Y.Z` 发布流程不会触发 tiny 包 workflow；tiny 包的 `tiny-subagent-vX.Y.Z` 也不会触发根包 workflow。两个包可以共用仓库和 `NPM_TOKEN`，但 npm 版本号、发布 tag 和 CI 发布步骤彼此独立。

### 首次启用自动发布（一次性）

1. npm 网页生成 token：`https://www.npmjs.com/settings/<你>/tokens` → Generate New Token → **Granular Access Token** → 勾 **Bypass 2FA** → 权限 Packages Read and write。
2. 存进 GitHub 仓库 Secrets：Settings → Secrets and variables → Actions → New secret → 名字 `NPM_TOKEN`。

### 更新已装机器的包

```bash
pi update npm:@maxiaochao/pi-toolkit      # 更新到最新发布版
pi remove npm:@maxiaochao/pi-toolkit      # 卸载
```

## 回滚

- **npm 侧**：`npm unpublish pi-toolkit@<坏版本>`（24h 内）或 `npm deprecate pi-toolkit@<坏版本> "broken, use X"`。
- **装包侧**：`pi install npm:@maxiaochao/pi-toolkit@<上一个好版本>` 或 `pi remove npm:@maxiaochao/pi-toolkit`。

## 迁移遗留的清理步骤（已装过旧版时）

- 删除全局旧扩展文件：`rm ~/.pi/agent/extensions/todo.ts`（避免与新包双注册）。
- 删除项目级旧包：把项目 `.pi/settings.json` 里 `"../pi-cache-dashboard"` 移除，删掉 `pi-cache-dashboard/` 目录。
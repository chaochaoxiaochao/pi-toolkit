# Global Agent Notes

本仓库是个人 pi 扩展包 `pi-toolkit` 的**源码与发布工程**。任何改动请遵循以下规则。

## 目录结构

```
pi-toolkit/
├── package.json            # pi manifest：pi.extensions 声明两个扩展入口
├── extensions/
│   ├── todo.ts             # /todos 扩展（来源于 ~/.pi/agent/extensions/todo.ts）
│   └── cache-export/       # /cache_export 交互式缓存仪表盘
│       ├── index.ts        # 入口：注册命令、输出路径、WSL 打开
│       ├── render.ts       # 聚合 + miss/streak 规则 + HTML 渲染（改逻辑在这里）
│       ├── tau-assets.ts   # tau 原版 CSS/JS 资产（勿手改，重生成，见下）
│       └── tests/          # 确定性测试（阈值边界、规则路径、退化输入）
└── scripts/release.sh      # 一键发布（测试→版本→tag→推→publish）
```

## 开发规则

- **改扩展逻辑**：改完必须跑 `npm test`（25 项确定性测试），再做 `npm run load-test`（`pi -e` 验证两个扩展能加载）。
- **不改 `tau-assets.ts`**：该文件从 `huggingface/tau` 的 `src/tau_coding/session_usage.py` 提取（USAGE_STYLES / USAGE_SCRIPT），保证与上游逐字节一致。需要更新时用提取脚本重生成，不要手改。
- **别用 `.mjs` 放扩展代码**：pi 的 `/reload` 走 jiti（moduleCache:false），只对 `.ts/.js` 生效；`.mjs` 走 Node 原生 ESM 缓存，reload 刷不掉，会导致“改了不生效”。
- 扩展依赖 pi 内置包时写进 `peerDependencies`（`@earendil-works/pi-*`、`typebox`），不要实装。

## 打包发布

### 前置条件（首次）

1. GitHub 建仓并关联：
   ```bash
   gh auth login                     # 未登录时
   gh repo create pi-toolkit --private --source . --remote origin --push
   # 或旧方式： git remote add origin git@github.com:<你>/pi-toolkit.git && git push -u origin main
   ```
2. package.json 的 `repository.url` 改成真实地址（占位符 `<YOUR-GITHUB-USER>`）。
3. npm 登录：
   ```bash
   npm login                          # 输入 npmjs 账号/OTP
   ```

### 发布流程（每次发版）

1. `./scripts/release.sh <patch|minor|major>`：本地跑测试 + 升版本（如 `v0.1.2`）＋写 CHANGELOG＋commit＋打 tag＋push。
2. **帮推 tag 会自动触发 GitHub Actions（.github/workflows/publish.yml）发布到 npm**——无人值守。
   - 前提：仓库 Secrets 里配好了 `NPM_TOKEN`（npm 的 granular access token + **Bypass 2FA**）。
   - 若本地 `~/.npmrc` 也配了 bypass token，脚本会顺带在本地直接 publish（可跳过 CI）。

手动等价命令（CI 存在时只需 push tag）：

```bash
npm test && npm version patch && git push && git push --tags
```

### 首次启用自动发布（一次性）

1. npm 网页生成 token：`https://www.npmjs.com/settings/<你>/tokens` → Generate New Token → **Granular Access Token** → 勾 **Bypass 2FA** → 权限 Packages Read and write。
2. 存进 GitHub 仓库 Secrets：Settings → Secrets and variables → Actions → New secret → 名字 `NPM_TOKEN`。
3. （可选）想本地直发：`echo '//registry.npmjs.org/:_authToken=你的token' >> ~/.npmrc`。

### 更新已装机器的包

```bash
pi update npm:pi-toolkit      # 更新到最新发布版
pi remove npm:pi-toolkit      # 卸载
```

## 回滚

- **npm 侧**：`npm unpublish pi-toolkit@<坏版本>`（24h 内）或 `npm deprecate pi-toolkit@<坏版本> "broken, use X"`。
- **装包侧**：`pi install npm:pi-toolkit@<上一个好版本>` 或 `pi remove npm:pi-toolkit`。

## 迁移遗留的清理步骤（已装过旧版时）

- 删除全局旧扩展文件：`rm ~/.pi/agent/extensions/todo.ts`（避免与新包双注册）。
- 删除项目级旧包：把项目 `.pi/settings.json` 里 `"../pi-cache-dashboard"` 移除，删掉 `pi-cache-dashboard/` 目录。
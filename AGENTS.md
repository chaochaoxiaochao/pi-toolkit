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

推荐跑 `scripts/release.sh`，它自动做下面 1–6：

1. `npm test` + 两个扩展的 `pi -e` 加载测试 —— 全过才继续。
2. 升版本：`npm version <patch|minor|major>`（也生成 git tag，如 `v0.1.0`）。
3. 更新 `CHANGELOG.md`（追加本次变更，格式见文件内范例）。
4. 提交并推送：`git push` + `git push --tags`（tag 与版本一致）。
5. 发布：`npm publish`（包名 `pi-toolkit`，已确认 npm 上可用；发布产物 = package.json `files` 白名单）。
6. 验证：`pi install npm:pi-toolkit` 后 `/reload`，试 `/todos` 与 `/cache_export`。

手动执行等价命令：

```bash
npm version patch && git push && git push --tags && npm publish
```

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
# Worktree 测试方案

## 流程

1. `npm --prefix packages/worktree test`：在临时 Git 仓库中运行 CLI，并验证 Extension 注册、延迟命令桥接和 session 切换生命周期。
2. `npm pack ./packages/worktree --dry-run`：确认 CLI、completion、skill 和安装脚本进入 tarball。
3. 手工验收发布包的 `pi-worktree create` 创建与复用流程。
4. 确认 README 示例、真实临时 Git 仓库输出 `docs/screenshot.png` 和 `docs/demo.gif` 进入 tarball。

## 用例数据

- `--help` 输出命令说明。
- `create` 从当前分支创建 `.worktrees/<name>` 并记录 base。
- `create --json` 覆盖 created、reused、already-active、dirty 和非法名称安全失败。
- `/worktree start` 把历史 fork 到 cwd 正确的新 session，再调用 `switchSession`。
- `enter_worktree` 串行创建或复用目标，在 `agent_settled` 后触发内部命令，并 fork 当前 session 后调用 `switchSession`。
- Agent 轮被中止时不触发切换；用户取消 session replacement 时删除派生 session。
- 自定义 session 目录在 fork 后保持不变。
- 已删除的 CLI `start` 和 `prepare` 会显式失败。
- `list` 标记主 checkout 和子 worktree。
- `info` 报告 clean、branch、base 和 ahead。
- postinstall 把可执行 CLI 与 completion 复制到隔离 HOME，并保持执行权限。

## 最近验证结果

验收要求全部 Node/shell 断言通过，Extension 能被 Pi 单独加载，且 `npm pack --dry-run` 包含 `bin/`、`extensions/`、`skills/` 和 `scripts/install.mjs`。

## Review regressions

The CLI integration suite also calls `create --json` from a nested linked-worktree directory. It asserts `already-active`, the canonical worktree root, and the whole-worktree dirty flag. Load the extension with `pi -ne -ns --no-session -e ./packages/worktree/extensions/worktree.ts`; this package has no `load-test` npm script.

# Worktree 测试方案

## 流程

1. `npm --prefix packages/worktree test`：在临时 Git 仓库中运行 CLI，并验证 Extension 注册和 session 切换协议。
2. `npm pack ./packages/worktree --dry-run`：确认 CLI、completion、skill 和安装脚本进入 tarball。
3. 手工验收发布包的 `pi-worktree start` 交互流程。
4. 确认 README 示例、真实临时 Git 仓库输出 `docs/screenshot.png` 和 `docs/demo.gif` 进入 tarball。

## 用例数据

- `--help` 输出命令说明。
- `start` 从当前分支创建 `.worktrees/<name>` 并记录 base。
- `prepare --json` 覆盖 created、reused、already-active、dirty 和非法名称安全失败。
- `/worktree start` 把历史 fork 到 cwd 正确的新 session，再调用 `switchSession`。
- `enter_worktree` 返回带 `pi-worktree/switch-request`、源 session、目标路径和 dirty 状态的 structured content，并请求终止当前工具轮。
- 假 Pi 收到正确工作目录和参数。
- `list` 标记主 checkout 和子 worktree。
- `info` 报告 clean、branch、base 和 ahead。
- postinstall 把可执行 CLI 与 completion 复制到隔离 HOME，并保持执行权限。

## 最近验证结果

验收要求全部 Node/shell 断言通过，Extension 能被 Pi 单独加载，且 `npm pack --dry-run` 包含 `bin/`、`extensions/`、`skills/` 和 `scripts/install.mjs`。

# Worktree 测试方案

## 流程

1. `npm --prefix packages/worktree test`：在临时 Git 仓库中使用假的 `pi` 命令运行 CLI。
2. `npm pack ./packages/worktree --dry-run`：确认 CLI、completion、skill 和安装脚本进入 tarball。
3. 手工验收发布包的 `pi-worktree start` 交互流程。
4. 确认 README 示例、真实临时 Git 仓库输出 `docs/screenshot.png` 和 `docs/demo.gif` 进入 tarball。

## 用例数据

- `--help` 输出命令说明。
- `start` 从当前分支创建 `.worktrees/<name>` 并记录 base。
- 假 Pi 收到正确工作目录和参数。
- `list` 标记主 checkout 和子 worktree。
- `info` 报告 clean、branch、base 和 ahead。
- postinstall 把可执行 CLI 与 completion 复制到隔离 HOME，并保持执行权限。

## 最近验证结果

迁移基线要求全部 shell 断言通过，且 `npm pack --dry-run` 包含 `bin/`、`skills/` 和 `scripts/install.mjs`。

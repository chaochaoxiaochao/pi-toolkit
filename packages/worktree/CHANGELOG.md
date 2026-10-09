# Changelog

## 2026-10-09 - v0.2.0

- add current-session worktree switching for users, Agents, and SDK Harnesses
- 新增 `/worktree start` 用户命令，在当前 Pi 界面中把持久会话 fork 并切换到 worktree。
- 新增 `enter_worktree` Agent Tool 和 `pi-worktree/switch-request` Harness 协议。
- 新增幂等的 `pi-worktree prepare --json` 机器接口，安全处理创建、挂载、复用、dirty 和 stale 状态。

## 2026-09-30 - v0.1.0

- 将 pi-worktree CLI、bash completion 和 Pi skill 合并为可独立安装的子包。

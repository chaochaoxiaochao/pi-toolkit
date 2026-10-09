# Changelog

## 2026-10-09 - v0.3.0

- automatically move Agent conversations into prepared worktrees without external Harness support
- 修复 `enter_worktree` 只创建目录却不切换的问题；现在 Extension 会在 `agent_settled` 后自动 fork 并切换当前会话，不再依赖外部 Harness 消费协议。
- 移除 v0.2.0 的 `pi-worktree/switch-request` 常量及 `kind/version/action/sessionFile` 输出字段；自定义 Harness 若曾消费该协议，需要改用 Extension 内置自动切换。

## 2026-10-09 - v0.2.0

- add current-session worktree switching for users, Agents, and SDK Harnesses
- 新增 `/worktree start` 用户命令，在当前 Pi 界面中把持久会话 fork 并切换到 worktree。
- 新增 `enter_worktree` Agent Tool 和 `pi-worktree/switch-request` Harness 协议。
- 新增幂等的 `pi-worktree prepare --json` 机器接口，安全处理创建、挂载、复用、dirty 和 stale 状态。

## 2026-09-30 - v0.1.0

- 将 pi-worktree CLI、bash completion 和 Pi skill 合并为可独立安装的子包。

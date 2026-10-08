# Todo 测试方案

## 流程

1. `npm --prefix packages/todo test`：运行状态机确定性测试和扩展/widget 集成测试。
2. `npm --prefix packages/todo run load-test`：让 Pi 加载真实扩展入口。
3. `npm pack ./packages/todo --dry-run`：确认发布文件完整。
4. 确认由真实状态机输出生成的 `docs/screenshot.png` 和 `docs/demo.gif` 可打开且进入 tarball。

## 用例数据

- 恢复旧格式记录、修复非法生命周期，并只从当前分支快照重建。
- 非空 `plan` 保留关闭历史、取消旧未完成步骤并使用单调新 ID；`plan([])` 留下空当前计划。
- `expected_current_id` 的 stale、重复和缺失调用原子失败；顺序完成与取消每次只推进一步。
- `add_step` 只追加，步骤文本不作为 marker 或唯一键解释。
- 并发发起的调用按提交顺序串行化，同轮重复 completion 不会跨越两个步骤。
- 已挂载 widget 从实时状态重渲染、主动请求 TUI render、隐藏内部 ID 和关闭历史，并在计划结束时消失。
- `/todos` 展示完整当前分支历史，而所有工具结果只返回规范 `CURRENT plan`。

## 最近验证结果

迁移基线：状态机和扩展集成测试全部通过，扩展可由 Pi 独立加载。发布前必须重新运行上述三步；跳过的检查不算通过。

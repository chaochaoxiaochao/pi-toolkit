# Todo 测试方案

## 流程

1. `npm --prefix packages/todo test`：运行纯状态机确定性测试。
2. `npm --prefix packages/todo run load-test`：让 Pi 加载真实扩展入口。
3. `npm pack ./packages/todo --dry-run`：确认发布文件完整。
4. 确认由真实状态机输出生成的 `docs/screenshot.png` 和 `docs/demo.gif` 可打开且进入 tarball。

## 用例数据

- 恢复旧格式记录并修复非法生命周期。
- `replace` 取消旧的活跃任务并建立新队列。
- 完成当前任务后自动推进下一项。
- 删除、清空、非法 ID 和非法状态处理。
- widget 队列位置连续，内部 ID 保持稳定。

## 最近验证结果

迁移基线：状态机测试全部通过，扩展可由 Pi 独立加载。发布前必须重新运行上述三步；跳过的检查不算通过。

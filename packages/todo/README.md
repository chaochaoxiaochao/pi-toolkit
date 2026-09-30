# @maxiaochao/pi-todo

Pi 的会话清单扩展，提供 `todo` 工具、自动推进的生命周期、活跃任务 widget 和 `/todos` 历史视图。

![Todo 真实状态机运行截图](docs/screenshot.png)

## 为什么有这个包

这是 pi-toolkit 自研的计划执行模块，用明确状态替代只存在于对话文本里的计划。它解决计划替换后旧任务残留、多个任务同时 doing、完成后不自动推进，以及 UI 序号与持久 ID 混用的问题。

## 演示

![Todo 生命周期演示](docs/demo.gif)

```text
todo({ action: "replace", items: ["Inspect callers", "Implement", "Verify"] })
todo({ action: "update", id: 1, status: "done" })
/todos
```

第一项完成后下一项自动进入 `doing`；`/todos` 同时展示活跃队列和关闭历史。

## 安装

完整工具包已经包含本扩展：

```bash
pi install npm:@maxiaochao/pi-toolkit
```

只需要 todo 时单独安装：

```bash
pi install npm:@maxiaochao/pi-todo
```

两种方式二选一，避免重复注册。

## 更新

```bash
pi update npm:@maxiaochao/pi-toolkit  # 更新主包内置版本
pi update npm:@maxiaochao/pi-todo     # 更新独立子包
```

两个 npm 包版本独立。Todo 源码变更只有在发布新主包后才会到达主包用户，发布子包本身不会更新主包。

## 行为

- `replace` 用新计划替换旧计划，并将未完成旧任务标记为取消。
- `add`、`update`、`remove`、`clear` 管理任务。
- 同一时间最多一个任务为 `doing`，完成后自动推进下一项。
- widget 使用连续队列位置；持久记录保留稳定内部 ID。

## 开发与测试

权威源码位于 `extensions/` 和 `src/`。测试流程、用例和最近验证结果见 [TESTING.md](TESTING.md)。

```bash
npm --prefix packages/todo test
npm --prefix packages/todo run load-test
npm pack ./packages/todo --dry-run
```

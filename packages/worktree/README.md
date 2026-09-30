# @maxiaochao/pi-worktree

`pi-worktree` CLI 与配套 Pi skill。CLI 创建、检查和清理 Git worktree，并在隔离目录中启动 Pi。

![Worktree 在真实临时 Git 仓库中的运行截图](docs/screenshot.png)

## 为什么有这个包

这个包把原来分散在主包中的 shell CLI、bash completion、安装逻辑和 agent skill 合成一个发布单元。它让人和 agent 使用同一套隔离流程，避免在主 checkout 中混入并行任务改动。

## 演示

![Worktree 隔离流程演示](docs/demo.gif)

```bash
pi-worktree start feature -p "implement the feature"
pi-worktree info feature
pi-worktree out
pi-worktree remove feature
```

`start` 从当前分支创建或复用 `.worktrees/feature`，记录 base，并在该目录启动 Pi。

## 安装

完整工具包已经包含 CLI 和 skill：

```bash
pi install npm:@maxiaochao/pi-toolkit
```

只需要 worktree 能力时单独安装：

```bash
pi install npm:@maxiaochao/pi-worktree
```

postinstall 会把 CLI 复制到 `~/.local/bin/pi-worktree`，把 bash completion 安装到 `~/.local/share/bash-completion/completions/pi-worktree`。两种安装方式二选一。

## 更新

```bash
pi update npm:@maxiaochao/pi-toolkit  # 更新主包内置的 CLI 与 skill
pi update npm:@maxiaochao/pi-worktree # 更新独立子包
```

更新会重新运行安装逻辑并覆盖 `~/.local/bin/pi-worktree` 和 completion。主包与子包版本独立，不要同时安装。

## 命令

```bash
pi-worktree start <name> [pi args...]
pi-worktree list
pi-worktree info <name>
pi-worktree out
pi-worktree remove <name>
pi-worktree prune
```

Agent 用法见 `skills/pi-worktree/SKILL.md`。测试流程、夹具和结果见 [TESTING.md](TESTING.md)。

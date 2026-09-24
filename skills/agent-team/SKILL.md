---
name: agent-team
description: 以对抗评审的方式让不同厂商的模型交叉验证同一个结论，当前会话担任管理者。Use when the user asks for 对抗评审 / 交叉验证, or wants a long-running investigation red-teamed by independent agents.
disable-model-invocation: true
---

当前会话是**管理者**，不是转述人：自己也承担一份实证工作，并对每一轮的裁决负责。队员是长驻的 herdr pane，不是一次性 subagent —— 它们要能被反复追问、被点名互相反驳。

herdr 的完整 CLI 语义在 `herdr --skill`，本文只写这套协作协议。

## 何时值得开

只在用户要求组队时开，它会在用户的终端里真的分屏。值得开的条件：结论会驱动一个代价高的动作（改内核、下线设备、向客户定责），或者证据链已经长到单模型会自我确认。查一个事实、读一份文件用不上。

## 1. 建队

**必须跨厂商。** 同厂同代模型共享盲区，三个一起点头等于一个点头。

名单在同目录的 `models.json`，先读它，照里面的 `model` 字段写命令；用户指定了别的模型就用用户的。每个成员有 `name` / `model` / `role` / `charter`，`defaults` 里是共用的 `kind` 与 `thinking`。

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
herdr agent start <name> --kind pi --pane <pane> -- --model <model> --thinking <thinking>
echo <pane> > /tmp/pane_<name>
```

pane id 落盘，后面所有广播脚本都从这里取。开完把该成员的 `charter` 作为第一条 prompt 发过去，立常设职责。`herdr agent list` 确认都是 idle 再开工。

## 2. 分角色：互不重叠的攻击面

每个 pane 领一个**方法论上互斥**的职责：`auditor` 审源码、`replicator` 复算数据、`adversary` 攻方法学。具体措辞是 `models.json` 里各自的 `charter`，改职责改那里。

## 3. 交底与通信

herdr 没有邮箱，只有 `agent prompt`（往别人输入框塞文字）和 `agent read`（把别人屏幕刮下来）。拓扑是星型，管理者是唯一的路由：跨 pane 的话全部由管理者转述，把 A 的原话引进 B 的下一条 prompt（「opus 说你这个计数可能一对多，用数据回应」）。

```
                  管理者（本会话）
              唯一写 FINDINGS 的人
                │      │      │
   下行：消息  │      │      │   herdr agent prompt
   （短指针）  ▼      ▼      ▼
              ┌────┐ ┌──────┐ ┌──────┐
              │ sol│ │ grok │ │ opus │   彼此不相连
              └──┬──┘ └──┬───┘ └──┬───┘
                 │        │        │
   上行：文件     └───────┴───────┘
                          ▼
              /tmp/<轮次>-<name>.md ← 管理者从磁盘读
```

技术上任何 pane 都能 prompt 任何 pane，让它们直连有四个代价：管理者看不见这次交换，ledger 就缺一环；对正在 working 的 agent 发 prompt 会被拒（`agent_blocked`）或插进它当前那一轮；没有投递回执；而且两两串供会让它们彼此收敛，恰好毁掉跨厂商独立性这唯一的价值来源。

下行只发短指针，正文留在文件里：长文本经终端会被折断或触发意外快捷键。上行走文件：队员把结论写 `/tmp/<轮次>-<name>.md`，终端只回一行路径，管理者从磁盘读。`agent read` 是终端截图，会截断、会按宽度折行、会混进 TUI 边框，拿它收长输出必丢内容；只用它确认回执和状态。

基准文档 `FINDINGS-stageN.md` 是**唯一事实源**，只有管理者写，新版本整体取代旧版本而不是打补丁。必含四块：机制链、编号发现、已推翻清单、未闭合点。

```bash
MSG='【N17】读 /tmp/FINDINGS-stage4.md 全文。本轮你的攻击点：……。结论写 /tmp/N17-<你的名字>.md，终端只回一行路径。'
for a in sol grok opus; do herdr agent prompt "$a" "$MSG"; done
for a in sol grok opus; do herdr agent wait "$a" --until idle --timeout 900000; done
```

## 4. 回合

一轮 = 广播 → 各自独立干 → 管理者从磁盘收文件 → 裁决 → 更新文档 → 再广播。

每轮广播里给每个 pane 一个**具体到能证伪的攻击点**（「查 ART 的 adbconnection.cc，确认这条错误日志与被销毁的 fd 是不是 1:1」），而不是「你看看有没有问题」。

## 5. 纪律

- **ledger**：发现按 `N1, N2…` 只增不改；每一条被推翻的结论进 `X1, X2…` 清单，写明是谁推翻的。这份 X 清单是最终交付里最有价值的部分。
- **retraction 要公开**：管理者被驳倒时，在下一次广播开头显式写「我错了，更正为……」。管理者一旦开始维护自己的结论，pane 就会停止攻击，整个队伍塌成回音室。
- **replication**：任何承载结论的数字至少两方独立算。对不上先查口径再查代码。
- **control**：任何「异常」指标必须配阴性样本才进文档。拿不出对照的指标只是一个数。
- **grading**：每条结论标注 `源码读取 / 实测 / 推断` 和置信度。推断不能和实测并列陈述。
- **裁决**：两个 pane 冲突时判出谁对，并说明依据。把冲突的结论平均掉会同时丢掉两边的信息。

## 6. 收尾

收敛判据：完整一轮广播后没有任何 pane 能产出新的 X。

最终文档必须单列**未闭合点**，以及**每一个需要人或设备批准才能执行的动作**。

用完 `herdr pane close <pane_id>` 关掉，pane 不会自己退出。

## 故障

- pane 额度耗尽：降级为剩余 pane 继续，并在文档里记下缺失的是哪个视角。
- agent 卡在 blocked：`herdr agent read <name> --source visible` 看它在等什么，多半是在等一个确认。
- 广播后无人响应：`herdr agent list` 核对 pane 是否还活着，pane id 会随布局变化。

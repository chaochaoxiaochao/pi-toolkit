# Codex Edit 测试报告

**回归检查：通过；Agent Benchmark：通过（有共同例外）**

被测包：`@maxiaochao/pi-codex-edit`（当前工作区）

本报告严格区分真实模型基准、确定性协议回归和安全回归，三类成功率不会混算。

## 执行摘要

- Agent Benchmark：**通过（有共同例外）** — 已完成 300/300 条 chain；本地版 First Exact 92/100、Final Exact 92/100，全部正式门槛通过。
- 协议/包回归：**通过** — 4/4 项检查通过。
- 安全回归：**5/5 正确拒绝且零写入**，包括工作区外路径。
- 下文提供 Agent、协议、安全、效率、版本、integrity 和任务来源的完整证据。

## Agent Benchmark：真实模型基准

**状态：通过（有共同例外）**

三个测试臂均完成全部 100 个配对任务（共 300 条 chain），实际成本为 $12.388。本地版满足全部正式验收门槛；8 个最终失败均为三臂共同失败，不是本地版独有回归。

| 测试臂 | 覆盖率 | First Exact | Final Exact | 恢复次数 / 净增益 | Score v2 | 成本 | Token | 耗时 | 工具调用 | 失败调用 | Provider 失败 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 原生 edit | 100/100 | 91/100 (91.00%) | 92/100 (92.00%) | 41 / +1 | 91.25% | $4.104 | 1,253,279 | 2887.2s | 225 | 0 | 0 |
| 发布版 0.1.7 | 100/100 | 91/100 (91.00%) | 92/100 (92.00%) | 41 / +1 | 91.25% | $4.139 | 1,080,588 | 2777.4s | 198 | 0 | 0 |
| 本地修改版 | 100/100 | 92/100 (92.00%) | 92/100 (92.00%) | 40 / +0 | 92.00% | $4.145 | 1,049,619 | 2838.0s | 194 | 0 | 0 |

Score v2 = `覆盖率 ×（0.75 × 首次精确率 + 0.25 × 最终精确率）`。本地版为 92.00%，严格高于原生 edit 和发布版的 91.25%。

### 完整配对结果

| 对比 | 指标 | 本地版胜 | 本地版负 | 持平 |
|---|---|---:|---:|---:|
| 本地版 vs 原生 edit | 首次精确 | 1 | 0 | 99 |
| 本地版 vs 原生 edit | 最终精确 | 0 | 0 | 100 |
| 本地版 vs 发布版 | 首次精确 | 1 | 0 | 99 |
| 本地版 vs 发布版 | 最终精确 | 0 | 0 | 100 |

首次精确的两个本地版净胜任务分别是：相对原生 edit 的 `delete-subset-1000-plain`，以及相对发布版的 `copy-block-10-plain`。最终精确没有配对差异。

### 正式验收门槛

| 门槛 | 结果 |
|---|---|
| 本地 Score v2 严格高于原生 edit | 通过 |
| 本地 First Exact 不低于原生 edit | 通过 |
| 本地 Final Exact 距最佳对照不超过 2/100 | 通过 |
| 相对发布版的改善数不少于回归数 | 通过 |
| 本地独有最终回归不超过 2 个 | 通过 |
| 四项效率至少三项不差于原生，且单项恶化不超过 10% | 通过 |

### 相对原生 edit 的效率

| 指标 | 原生 edit | 本地版 | 变化 | 判定 |
|---|---:|---:|---:|---|
| 成本 | $4.104 | $4.145 | 1.01% | 轻微恶化，低于 10% 上限 |
| Token | 1,253,279 | 1,049,619 | -16.25% | 改善 |
| 耗时 | 2887.2s | 2838.0s | -1.70% | 改善 |
| 工具调用 | 225 | 194 | -13.78% | 改善 |

本地版四项效率中三项优于原生 edit；成本增加约 1%，没有任何指标恶化超过 10%，也没有超过 20% 的警告项。

### Cohort 覆盖

| Cohort | 计划任务 | 已完成配对任务 | 原生 First / Final | 发布版 First / Final | 本地版 First / Final |
|---|---:|---:|---:|---:|---:|
| neutral | 80 | 80 | 73/74 | 73/74 | 74/74 |
| challenge | 20 | 20 | 18/18 | 18/18 | 18/18 |


### 任务类别明细（First / Final / 总数）

| 类别 | 配对任务 | 原生 edit | 发布版 | 本地版 |
|---|---:|---:|---:|---:|
| copy-block | 3 | 3/3/3 | 2/3/3 | 3/3/3 |
| copy-within | 3 | 3/3/3 | 3/3/3 | 3/3/3 |
| delete-block | 3 | 3/3/3 | 3/3/3 | 3/3/3 |
| delete-subset | 3 | 2/3/3 | 3/3/3 | 3/3/3 |
| distinct-edits | 4 | 4/4/4 | 4/4/4 | 4/4/4 |
| insert-block | 3 | 3/3/3 | 3/3/3 | 3/3/3 |
| insert-payload | 3 | 3/3/3 | 3/3/3 | 3/3/3 |
| insert-subset | 3 | 3/3/3 | 3/3/3 | 3/3/3 |
| language-insert | 13 | 13/13/13 | 13/13/13 | 13/13/13 |
| language-replace | 13 | 13/13/13 | 13/13/13 | 13/13/13 |
| language-select | 13 | 13/13/13 | 13/13/13 | 13/13/13 |
| literal | 5 | 5/5/5 | 5/5/5 | 5/5/5 |
| move-between | 4 | 4/4/4 | 4/4/4 | 4/4/4 |
| move-block | 3 | 3/3/3 | 3/3/3 | 3/3/3 |
| multi-file | 4 | 4/4/4 | 4/4/4 | 4/4/4 |
| replace-all | 3 | 3/3/3 | 3/3/3 | 3/3/3 |
| replace-block | 3 | 3/3/3 | 3/3/3 | 3/3/3 |
| select-one | 4 | 4/4/4 | 4/4/4 | 4/4/4 |
| select-subset | 4 | 2/2/4 | 2/2/4 | 2/2/4 |
| unicode-fix | 4 | 0/0/4 | 0/0/4 | 0/0/4 |
| unique | 2 | 0/0/2 | 0/0/2 | 0/0/2 |

### 共同例外

三臂最终均失败的 8 个任务为：`select-subset-1000-unicode`、`select-subset-1000-plain`、4 个 `unicode-fix-*` 任务，以及 `unique-10-plain`、`unique-100-unicode`。它们不构成本地修改版回归；本地独有最终回归为 0。

### 可复现信息

- 数据源：https://github.com/alexshpunt/explicit-edit-benchmark，commit `5827e3fb65845f4b76adb06e5919d94ec4ffd5cf`。
- 冻结任务：80 Neutral + 20 Challenge；seed 为 `pi-toolkit-codex-edit-100-v1`。
- 模型：`openai-codex/gpt-5.6-sol`；reasoning：`low`；Pi：`0.85.1`；最多 5 次 Oracle recovery。
- 发布版：`@maxiaochao/pi-codex-edit@0.1.7 (sha512-hfNfx20h51FLCueXaMqBUAVYnxoCakuI306rzuFPI/lS0HT1jE/wQ8xkKl9PwEXboVVD6ZzS/YB0VVrd67V7cw==)`。
- 本地版：`@maxiaochao/pi-codex-edit@0.1.7+local (sha512-Mf21ZfSwOOgaH2lSiF/DpoA8Jk5jH84MaZUX1abkMop3HST3xt2YtCw2NKwrRJpvmJB02bl9wwYyFlAVI68Qwg==)`。
- Run ID：`explicit-edit-100-sol-low-v3-complete`；运行完整性：300/300。
- Identity：task manifest `cab0278f530271c7bb3de3e4dba6ab252fa2b748d00164e749ecdbd8f9f7f431`；config `739bb323275fdcead7709f19a894b0dee57062f40064c04d182d96474535328c`；verifier `8bd4be15c886bba84e8a6fa46576c43f2ca0f02d2536d98403f97361914a166d`。
- Provider 失败：0；失败工具调用：0。


## 协议与包验证摘要

| 检查项 | 结果 | 命令 |
|---|---|---|
| Node 回归测试 | 通过 | `node --experimental-strip-types --test tests/package.test.mjs tests/parser.test.mjs tests/released-vs-local.test.mjs tests/benchmark.test.mjs` |
| 原生 edit 与本地 Codex Edit 对比 | 通过 | `pi -ne -e ./tests/native-vs-codex.ts` |
| 扩展加载 | 通过 | `pi -ne -e ./extensions/codex-edit.ts` |
| 独立包 tarball | 通过 | `npm pack --dry-run --json` |

## 确定性回归基线

- Node 测试：预期 22 个，覆盖 parser、matcher、路由、包契约、resolved-path 防护、发布版对比、分层调度和生产事故语料。
- 共享对比 corpus：12 个 case。
- 原生 edit：5 通过 / 2 失败或正确拒绝 / 5 不适用。
- Codex Edit 发布版 v0.1.7：6 通过 / 6 失败或正确拒绝。
- Codex Edit 本地版：7 通过 / 5 正确安全拒绝。

“正确拒绝”表示无效或陈旧操作被拒绝，且工作区没有变化。“不适用”表示 Pi 原生 `edit` 无法用一次编辑协议调用表达该操作，不计为工具缺陷。

## 安全回归

本地版 5/5 个安全 case 均正确拒绝，且工作区零写入。特别是 `outside-workspace-absolute-path` 的结果为 **工作区外路径 — 正确拒绝**；放行该操作会允许任意写入 benchmark sandbox 之外。安全拒绝不计入编辑失败率。

## 生产事故回归

这些 case 来自实际报告过的问题。Agent-and-protocol case 使用不包含工具语法提示的用户任务，可进入后续付费模型运行；protocol-only case 只验证指定工具形态，不用于宣称模型质量提升。

| Incident | 层级 | 对应回归 | 问题 |
|---|---|---|---|
| `incident-repeated-markdown-context` | agent-and-protocol | `repeated-markdown-separator` | 重复 Markdown 分隔符曾触发 ambiguous match |
| `incident-repeated-update-same-path` | protocol-only | `repeated-update-same-path` | 同一个 raw path 的多个 Update File 块在发布版中冲突 |
| `incident-runner-type-rename` | agent-and-protocol | `ordered-runner-type-renames` | runner.ts 中重复类型名的大范围重命名曾触发 ambiguous match |
| `incident-multi-file-structural-edit` | agent-and-protocol | `multi-file-add-delete-move` | 一次 patch 中的 add/delete/move 需要原子预校验和执行 |
| `incident-bom-crlf` | agent-and-protocol | `bom-and-crlf` | UTF-8 BOM 与 CRLF 曾导致原生精确文本匹配失败 |

冻结的 100-task 清单按每 5 个任务包含 4 Neutral + 1 Challenge 的顺序调度；本次完整运行覆盖全部 80 个 Neutral 和 20 个 Challenge。

## 确定性对比结论

每个测试臂运行同一组 12 个 case。对比 1 执行 24 次工具调用（原生 + 本地）；对比 2 执行 24 次 parser/执行评估（发布版 + 本地）。下表以 7 个有效编辑任务为完成率分母；5 个故意无效或危险的 patch 单独计入安全检查。

### 1. Pi 原生 edit vs Codex Edit 本地版

| 指标 | Pi 原生 edit | Codex Edit 本地版 | 变化 |
|---|---:|---:|---:|
| 有效任务完成 | 5/7 | 7/7 | +2 个 |
| 有效任务完成率 | 71.4% | 100.0% | +28.6 pp |
| 有效任务失败 | 1/7 | 0/7 | 减少 1 个 |
| 有效任务不适用 | 1/7 | 0/7 | 减少 1 个 |
| 正确拒绝适用的危险/陈旧 patch | 1/1 (100.0%) | 5/5 (100.0%) | Codex 覆盖全部 5 个 |

### 2. Codex Edit 发布版 v0.1.7 vs 本地修改版

| 指标 | 发布版 v0.1.7 | 本地修改版 | 变化 |
|---|---:|---:|---:|
| 有效任务完成 | 6/7 | 7/7 | +1 个 |
| 有效任务完成率 | 85.7% | 100.0% | +14.3 pp |
| 安全 case 正确拒绝 | 5/5 (100.0%) | 5/5 (100.0%) | 无变化 |
| 保留原有通过任务 | 6/6 | 6/6 | 100% 保留 |

这些是确定性协议/执行成功率，不是独立模型采样成功率。Agent 质量、token、成本和耗时只在 Agent Benchmark 章节报告。

## 逐 case：原生 edit vs 本地 Codex Edit

该对比在隔离临时工作区中执行 Pi 导出的 `createEditToolDefinition`，以及本地扩展实际注册的 `apply_patch`。

| Case | 原生 edit | 本地 Codex Edit | 说明 |
|---|---|---|---|
| `unique-replacement` | 通过 | 通过 | 预期行为一致 |
| `disjoint-edits-one-file` | 通过 | 通过 | 预期行为一致 |
| `repeated-markdown-separator` | 正确拒绝/失败 | 通过 | Codex 协议可处理该形态 |
| `repeated-update-same-path` | 通过 | 通过 | 预期行为一致 |
| `ordered-runner-type-renames` | 通过 | 通过 | 预期行为一致 |
| `multi-file-add-delete-move` | 不适用 | 通过 | Codex 协议可处理该形态 |
| `stale-expected-lines` | 正确拒绝/失败 | 正确拒绝/失败 | 预期行为一致 |
| `conflicting-targets` | 不适用 | 正确拒绝/失败 | 两者均避免危险写入 |
| `empty-update-chunk` | 不适用 | 正确拒绝/失败 | 两者均避免危险写入 |
| `resolved-path-alias-conflict` | 不适用 | 正确拒绝/失败 | 两者均避免危险写入 |
| `outside-workspace-absolute-path` | 不适用 | 正确拒绝/失败 | 两者均避免危险写入 |
| `bom-and-crlf` | 通过 | 通过 | 预期行为一致 |

关键结果：本地 Codex Edit 可以处理重复 Markdown 上下文和多文件 add/delete/move；原生精确替换无法用一次调用安全表达这些形态。两者都会拒绝陈旧的预期文本。

## 逐 case：发布版 v0.1.7 vs 本地 Codex Edit

发布版测试臂使用从 tag `codex-edit-v0.1.7` 冻结的语义基线（source blob `e2896b59d40b5f6f01b3a4a7918476f4acc28cd8`）。

| Case | 发布版 v0.1.7 | 本地版 | 回归状态 |
|---|---|---|---|
| `unique-replacement` | 通过 | 通过 | 已保留 |
| `disjoint-edits-one-file` | 通过 | 通过 | 已保留 |
| `repeated-markdown-separator` | 通过 | 通过 | 已保留 |
| `repeated-update-same-path` | 正确拒绝/失败 | 通过 | 已修复 |
| `ordered-runner-type-renames` | 通过 | 通过 | 已保留 |
| `multi-file-add-delete-move` | 通过 | 通过 | 已保留 |
| `stale-expected-lines` | 正确拒绝/失败 | 正确拒绝/失败 | 已保留 |
| `conflicting-targets` | 正确拒绝/失败 | 正确拒绝/失败 | 已保留 |
| `empty-update-chunk` | 正确拒绝/失败 | 正确拒绝/失败 | 已保留 |
| `resolved-path-alias-conflict` | 正确拒绝/失败 | 正确拒绝/失败 | 已保留 |
| `outside-workspace-absolute-path` | 正确拒绝/失败 | 正确拒绝/失败 | 已保留 |
| `bom-and-crlf` | 通过 | 通过 | 已保留 |

关键结果：`repeated-update-same-path` 从 v0.1.7 的失败变为本地版通过。既有成功 case 全部保留；陈旧、空 chunk、冲突和 resolved-alias 目标仍会被安全拒绝。

## 已报告错误覆盖

| 错误形态 | 当前策略 | Corpus 覆盖 |
|---|---|---|
| 重复 Markdown/HTML 区域或重复类型名（`Ambiguous ... match`） | 从当前 hunk cursor 起选择第一个匹配，hunk 按源位置排序 | `repeated-markdown-separator`、`ordered-runner-type-renames` 及 parser HTML 测试 |
| 同一 raw path 出现多个普通 `Update File` | 合并后按顺序执行 | `repeated-update-same-path` |
| Add/delete/move 或 resolved path alias 冲突 | 写入前拒绝 | `conflicting-targets`、`resolved-path-alias-conflict` |
| 工作区外绝对路径 | 读取或写入前正确拒绝 | `outside-workspace-absolute-path` |
| 空 update chunk | 拒绝，不猜测意图 | `empty-update-chunk` |
| 陈旧预期行 | 拒绝；调用方必须重新读取并生成 patch | `stale-expected-lines` |
| 缺少 `patch` 参数 | 必填 TypeBox schema 在扩展执行前拒绝 | 包契约测试 |

## 上游实现对齐

报告结构遵循 OpenAI Codex 的 scenario-test 模式：输入文件 + patch + 精确预期的最终文件系统。新旧 parser 对比采用 Codex 统一 streaming parser 时使用的差分测试方法。

本地 repeated-header 支持是有意加入的兼容扩展。当前 Codex 已验证实现会拒绝多个操作解析到同一路径，并推荐在一个 `Update File` 下使用多个 `@@` chunk。本实现只容忍 raw path 完全相同的重复普通 update；resolved alias 和破坏性操作冲突仍会拒绝。

来源：
- OpenAI Codex scenario tests: https://github.com/openai/codex/blob/9a8730f3/codex-rs/apply-patch/tests/suite/scenarios.rs
- OpenAI Codex parser differential validation: https://github.com/openai/codex/commit/e26f734f919819bdd802b1b67ad653863c7a90e5
- Duplicate resolved-path guard: https://github.com/openai/codex/pull/37867

## 维护规则

每个新的生产失败都必须先转化为 `tests/comparison-cases.mjs` 中的最小 case，并明确原生、发布版和本地版预期。已有 case 保持不变。发布前运行两组对比并重新生成本报告。模型路由、prompt 或 schema 变化还必须运行独立的真实模型 A/B benchmark。

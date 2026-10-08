# Codex Edit 测试方案

## 流程

1. `npm --prefix packages/codex-edit test`：运行 parser、matcher、路由、工具契约、包结构、下面两组强制对比、入口加载和 tarball 检查；随后生成 `docs/test-report.md` 并从该 Markdown 转换为自包含 `docs/test-report.html`。这是秒级反馈环，修改 parser 前必须先让对应回归用例变红。
2. `pi -ne -e ./packages/codex-edit/extensions/codex-edit.ts`：加载权威入口；独立子包与根包 manifest 都指向该实现。
3. `npm pack ./packages/codex-edit --dry-run`：检查独立 tarball。
4. 在根目录运行 `npm test`、`npm run load-test` 和 `npm pack --dry-run`，确认主包内嵌的同一份实现没有退化。
5. 确认 README 的协议示例、真实 parser 运行输出 `docs/screenshot.png` 和 `docs/demo.gif` 随两个 tarball 发布。

`docs/test-report.md` 是报告内容的权威中间产物，HTML 是每次测试生成的交付视图。提交或发布 Codex Edit 改动时必须包含两者，且 HTML 顶部 Overall 必须为 PASS。

## 两组强制对比

1. `npm --prefix packages/codex-edit run test:compare-native`：使用当前 Pi 公开导出的真实 `createEditToolDefinition` 和本地 extension 实际注册的 `apply_patch`，将两个真实工具跑在同一组临时 workspace 与期望文件快照上；失败 case 还要求 Codex Edit 不产生部分写入。它比较编辑协议能力和确定性结果，不替代真实模型质量 benchmark。
2. `npm --prefix packages/codex-edit run test:compare-released`：将冻结的 npm `v0.1.7` parser 语义与本地 parser 跑在同一个 corpus 上，明确显示旧版失败而本地修复成功的 case，并锁住旧有成功/安全失败行为。

共享语料在 `tests/comparison-cases.mjs`。每次出现新的生产报错，先把最小复现加入此文件，并分别声明 native、released、local 的预期；不要改写旧 case 来让测试变绿。冻结基线 `tests/legacy-parser-v0.1.7.mjs` 不得随本地实现修改。若以后发布新基线，应新增版本文件并保留旧基线。

这套结构参考 OpenAI Codex 的 [`apply-patch` scenario tests](https://github.com/openai/codex/blob/9a8730f3/codex-rs/apply-patch/tests/suite/scenarios.rs)：以输入文件、patch 和期望最终文件系统为真值；parser 变更还应做旧/新差分。上游在统一 streaming parser 时另用 24 小时 2,788,059 个真实 payload 做过差分验证（[`e26f734`](https://github.com/openai/codex/commit/e26f734f919819bdd802b1b67ad653863c7a90e5)）。本仓库没有该生产 corpus，因此不能宣称同等覆盖；这里只采用可持续扩充的方法。

当前 Codex verified invocation 会拒绝解析后指向同一路径的多个 operation（见 [`invocation.rs`](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/invocation.rs) 和 [duplicate-path change](https://github.com/openai/codex/pull/37867)）。本地只对“完全相同 raw path + 无 move 的纯 update”提供顺序容错，这是针对已观察模型输出的明确扩展；解析路径别名及 add/delete/move 冲突仍由执行层拒绝。

## 回归矩阵

| 形态 | 预期 | 锁定位置 |
|---|---|---|
| Add/Delete/Update/Move、多 hunk、BOM、CRLF、EOF | 正确解析并保留文件格式 | `parser.test.mjs` |
| 重复 HTML section、Markdown `---` | 从当前 cursor 起选择第一个匹配，不再报 ambiguous | `parser.test.mjs` |
| 同一路径出现多个纯 `Update File` | 按块顺序执行，后一块可匹配前一块的输出 | `parser.test.mjs` |
| 同一路径混用 add/delete/move，或 move 目标冲突 | 在写文件前拒绝，避免覆盖 | `parser.test.mjs` |
| 空 update chunk | 明确拒绝，不猜测意图 | `parser.test.mjs` |
| expected lines 已过期 | 明确拒绝并带路径，不做模糊替换 | `parser.test.mjs` |
| `{}` / 缺少 `patch` 参数 | 由必填 TypeBox schema 在 execute 前拒绝 | `package.test.mjs` + Pi load test |
| 项目级多文件重构、重复 SKILL 分隔符、重复 tiny/release 文件块 | 解析为唯一文件操作并得到确定性结果 | `parser.test.mjs` |
| workspace escape | 拒绝 | `parser.test.mjs` |
| `gpt-5.6-*`、Responses API、disabled、自定义 glob | 仅允许规则内模型使用 `apply_patch`，其余回退 `edit` | `package.test.mjs` |

空参数是模型/提供方生成的无效工具调用，Pi 会在扩展 `execute` 之前拦截；parser 无法也不应为缺失 patch 猜内容。`Failed to find expected lines` 表示 patch 基于旧文件内容，安全行为是失败后重新读取并生成新 patch，而不是放宽到可能改错位置。

## 最近验证结果

当前基线为 22 个 Node 确定性测试及 12 个共享对比 case 全部通过。原生 edit 为 5 pass / 2 fail / 5 unsupported，本地 Codex Edit 为 7 pass / 5 正确安全拒绝；发布版 v0.1.7 为 6 pass / 6 fail，其中 5 个是正确安全拒绝，另 1 个是本地版已修复的同路径顺序 update。另有 5 个生产事故条目冻结真实问题来源，其中 4 个可进入 Agent Benchmark，1 个仅验证指定协议形态。真实触发过的 runner 类型重命名 ambiguous、重复同路径、空 chunk、stale context、解析路径别名冲突、工作区外绝对路径和项目级多文件形态均已进入回归集。发布前必须验证子包 tarball 和根包 tarball 都包含并成功加载该入口。

正式 Agent Benchmark 的预算门禁使用仓库内 `benchmark/run-with-budget.mjs` 包装上游 runner。不要修改 `/tmp` 中的 benchmark clone，也不要允许 `apply_patch` 写出当前工作区；工作区外路径必须作为 Safety Regression 正确拒绝。包装器在 `--stop-cost` 停止调度，并以 `--max-cost` 检查最终硬上限。

冻结清单使用 `benchmark/schedule.mjs` 按 4 Neutral + 1 Challenge 交错排序。任何 5-task 完整前缀都必须保持 80/20；当前调度测试同时断言第 47 个任务处应已覆盖 9 个 Challenge，防止预算停止再次只留下 Neutral。

`summary.md` 的 20-case 报告是历史证据。当前正式运行 `explicit-edit-100-sol-low-v3-complete` 已完成 300/300 条 chain，实际成本 $12.388；本地版 First Exact 92%、Final Exact 92%、Score v2 92.00%，满足全部正式门槛。原生与发布版均为 First 91%、Final 92%、Score v2 91.25%；8 个最终失败为三臂共同例外，本地独有最终回归为 0。

公开、去敏后的正式证据提交在 `benchmark/results/explicit-edit-100-sol-low-v3.json`。正常测试只读取该文件，因此干净 checkout 不依赖 `.cache`，且 Markdown 与 HTML 可逐字节重建。导入新运行时，使用 `benchmark/export-evidence.mjs <run-directory> <output.json>`；只有在确认运行完整性、配置 identity 和无敏感字段后才替换正式证据。预算必须在每次运行前声明 scheduling stop 与 hard cap，预算停止的前缀一律标为 INCOMPLETE，禁止选择性补跑后宣称完整。任何模型路由、prompt 或 tool schema 变化仍需重跑独立模型基准，不能用 parser 测试替代。

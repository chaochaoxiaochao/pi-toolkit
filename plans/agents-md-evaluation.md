# AGENTS.md 实效评测计划

## Context

目标是建立可重复的配对实验，回答当前全局 `AGENTS.md` 对 **需求明确的 coding 任务** 是否有净价值：是否提高任务完成率、减少过度设计或越界修改、改善复用和验证，同时衡量 token、步骤与延迟成本。

本次只评估跨项目规则，不评估仓库根项目规则。被测文件存在版本漂移：

- 实际安装版：`~/.pi/agent/AGENTS.md`，当前 Pi 真正加载的版本。
- 仓库源码版：`global/AGENTS.md`，比安装版额外包含 `Output Format Preference`。

“当前实际用处”默认指实际安装版。pilot 不混入源码候选版；报告只记录两者 hash 和差异，后续若需要再单独做第三条件。

固定模型：`pudu-openai-proxy/gpt-5.6-luna:high`。

公开方法依据：

- [Anthropic agent eval methodology](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)：明确 task、trial、grader、trajectory、outcome；coding 任务优先确定性 grader；每次从干净环境开始；随机 Agent 需要重复 trial。
- [SWE-bench](https://github.com/SWE-bench/SWE-bench)：固定仓库状态，以目标测试通过且原有测试不回归判定 patch。
- [ETH/SRI AGENTBench](https://arxiv.org/abs/2602.11988)：直接比较无 context、生成 context、开发者 context；开发者文件平均收益较小且增加步骤/成本，但每任务每条件只采样一次，因此不能替代本地重复实验。
- [Inspect AI](https://inspect.aisi.org.uk/) 与 [Harbor](https://harborframework.com/docs/tasks/task-tutorial)：提供 sandbox、重复运行、scorer、轨迹和汇总范式。第一阶段只测一个 Pi 模型，采用更轻量的本地 harness，借鉴其方法而不引入完整框架依赖。

## Approach

采用严格配对的上下文消融：同一任务、同一初始 Git 状态、同一模型和工具配置，只切换是否加载全局 context file。

### Conditions

- `none`：Pi 使用 `--no-context-files`，不加载任何 `AGENTS.md` / `CLAUDE.md`。
- `installed`：不传 `--no-context-files`，从仓库树外的临时 cwd 正常加载 `~/.pi/agent/AGENTS.md`。

两个条件都固定：

```text
--mode json
--no-session
--no-extensions
--no-skills
--no-prompt-templates
--no-themes
--no-approve
--tools read,bash,edit,write,grep,find,ls
--model pudu-openai-proxy/gpt-5.6-luna:high
```

每个 trial 在 `/tmp` 下创建独立 Git fixture，不能位于 `pi-toolkit` 父目录，避免意外加载仓库根 `AGENTS.md`。条件顺序交错，并随机决定每对任务先跑 `none` 还是 `installed`，降低模型服务时间漂移造成的偏差。

### Pilot Tasks

pilot 使用 6 个需求完整、预期行为明确的合成任务，共 `6 × 2 × 1 = 12` 次模型调用：

| Task | 明确请求 | 主要观察规则 | 确定性判定 |
|---|---|---|---|
| `shared-root-cause` | 修复一个 caller 暴露的规范化 bug | Read Before You Write / Surgical Changes | 隐藏测试覆盖 sibling caller；共享 helper 修复；caller 不散落补丁 |
| `reuse-existing-helper` | 修复 HTML 转义问题 | Reuse Before Writing | 隐藏边界测试；必须复用已有 helper；不得复制 escaping 实现 |
| `surgical-scope` | 修复布尔配置解析 | Surgical Changes | 目标与回归测试；只允许修改相关源文件和测试；忽略无关 typo/dead code bait |
| `minimal-implementation` | 添加一个规格完整的小功能 | Simplicity First | 行为测试；禁止额外配置层、无用抽象、新依赖或非请求文件 |
| `read-adjacent-contract` | 修改共享序列化行为且保持 caller contract | Read Before You Write | 隐藏 caller 合同测试；记录是否读取相关 exports/callers，但不强制唯一工具顺序 |
| `verify-complete-change` | 修复验证逻辑并补回归覆盖 | Goal-Driven Execution | 目标测试 + 原有测试；轨迹中实际运行相关测试；最终回复不得虚报验证 |

这些任务同时检验全局规则的潜在副作用：任务已经明确时，Agent 不应因“先思考/先澄清”规则而停止、询问不必要问题或只输出计划。

pilot 不覆盖 `Fail Visibly` 的缺失输入场景，也不对短任务强行评价 `Checkpoint Long-Running Work`。因此 pilot 结论只适用于明确、可执行的编码任务。正式 suite 扩展到 12 个任务时，再加入明确的多文件长任务来观察 checkpoint 行为；模糊需求和缺失输入另建独立 suite，不混入主指标。

### Grading

每题包含 base fixture、公开测试、隐藏 grader 和已知可通过的 oracle/reference patch。

主要指标：

- `task_resolution`：隐藏目标测试与原有回归测试全部通过，二元判定。
- `targeted_violation`：每题对应的可机器判定违规，例如修改无关文件、重复已有 helper、增加新依赖、只修一个 caller、未运行测试或虚报测试。

次要指标：

- 总分：结果正确性为主，行为约束为辅；每题 rubric 权重在运行前固定。
- wall time、assistant turns、tool calls、输入/输出/cache token。
- patch 文件数和行数、读取文件数、测试命令次数。

轨迹评分只检查与规则直接相关且允许多种正确路径的事实，不要求固定工具调用顺序。主观代码质量不作为 pilot 主结论；A/B 不一致样本由人工盲化复核。

### Statistics And Decision Rules

pilot 每题每条件一次，只验证 harness 和发现大差异，不做统计显著性声明。

正式实验计划为至少 `12 × 2 × 5 = 120` 次模型调用：

- 每题先计算两个条件各自的成功率和违规率。
- 以任务为聚类单位做 paired bootstrap 95% CI；同题 5 次 trial 不作为 5 个独立任务。
- 同时报绝对结果、paired delta、全部任务明细和成本差，不只报总体均值或 pass@5。

预注册解释规则：

- **强证据有效**：`task_resolution` paired delta 的 95% CI 下界大于 0。
- **实用有效**：成功率满足 5 个百分点非劣界限，目标违规率至少下降 10 个百分点，且 token 与耗时增幅均不超过 20%。
- **有害**：成功率明显退化，或成本增幅超过 20% 且没有可观察的违规率改善。
- **证据不足**：其余结果；继续增加任务覆盖，不据此立即删改规则。

## Files To Modify

计划获批后预计新增或修改：

- `evaluations/agents-md/README.md`：研究依据、协议、运行方式和结论边界。
- `evaluations/agents-md/cases/`：fixture、任务描述、公开测试、隐藏 grader 和 oracle patch。
- `evaluations/agents-md/run.mjs`：隔离 workspace、Pi A/B 调用、顺序交错、JSONL 轨迹解析和错误分类。
- `evaluations/agents-md/report.mjs`：任务级统计、paired bootstrap、JSON 与自包含 HTML 报告。
- `evaluations/agents-md/tests/`：不调用模型的 runner、grader、统计和隔离测试。
- `package.json`：增加独立 `eval:agents` 命令，不改变现有 `npm test` 语义。
- `.gitignore`：忽略本地评测产物目录。

不会修改 `global/AGENTS.md` 或 `~/.pi/agent/AGENTS.md`。

## Reuse

- 复用 Pi CLI 的 `--no-context-files` 和 `--mode json`，不另写 Agent loop。
- 复用 Pi JSON 事件中的 assistant message、tool execution、usage 和错误事件。
- 复用 `extensions/cache-export/tests/run-tests.mjs` 的 Node 断言、临时目录和确定性测试风格。
- 复用 Git diff/status 进行修改范围评分，Node 内置 test/assert 执行公开与隐藏测试。
- 采用 SWE-bench 的目标测试 + 防回归测试、Anthropic 的 outcome/trajectory 分层和 AGENTBench 的 paired context ablation。

## Steps

- [x] 只评估全局规则，不评估项目根规则，不使用 Git 历史任务。
- [x] 固定模型为 `pudu-openai-proxy/gpt-5.6-luna:high`。
- [x] 明确主范围为需求完整、应直接执行的编码任务。
- [x] 核对源码版与实际安装版 hash；确认存在 `Output Format Preference` 漂移。
- [x] 完成公开体系调研并确定轻量 paired A/B 方法。
- [x] 实现 6 个 pilot fixture、隐藏 grader 和 oracle patch。
- [x] 实现隔离 runner、条件检查、轨迹保存、错误分类和报告。
- [x] 添加不调用模型的 harness 测试，验证 base 必败、oracle 必过、workspace 无父级 context 污染。
- [x] 生成 pilot 任务矩阵和空报告，人工检查任务描述与 grader 没有歧义或泄漏。
- [x] 完成独立 reviewer gate，并修复 baseline commit、测试成功关联、错误分类、精确 allowlist、结构化文件观察与缺失 cost 表示问题。
- [x] 经用户确认后运行 12 次真实模型 pilot。
- [x] 盲化审查所有 A/B 不一致轨迹及抽样共同成功/共同失败轨迹。
- [x] 修复盲审发现的 `read-adjacent-contract` 漏洞；用户确认扩展到 12 题 × 5 次正式实验，并新增 6 个高区分度 fixture。
- [x] 修复正式 gate 发现的 regression assertion shortcut、stale test success、宽松 verification report、shell 读取误扣分和 reviewed-matrix 绑定缺口。
- [x] 重新生成正式 dry-run：12 cases、120 jobs、12/12 base 必败且 oracle 必过；case definition hash 为 `5b57ec74794a5b15b87d7212242bb4a80fa497b71d8e37dced928a4173a7f5bf`。
- [x] 使用重新审阅的 matrix 完成 120 次正式模型调用：120 `ok`，两条件 task resolution 均为 100%，无 infrastructure、harness 或 Agent error；盲审全部 14 个 rubric 不一致 pair，并抽样共同结果。
- [x] 按规则主题完成建议：总体证据不足，不删除规则；保留并继续测试 `Reuse Before Writing`，简化可能过度规定实现位置的措辞，`Think Before Coding` 与 `Checkpoint Long-Running Work` 在本实验中未被覆盖。原始报告保留，另提供盲审 adjudicated sensitivity。

## Verification

- fixture base 必须在目标检查上失败，oracle patch 必须让目标与回归检查全部通过。
- runner 必须保存 Pi 版本、精确模型、thinking、工具集、两份指令 hash、条件参数和开始时间。
- `none` 必须带 `--no-context-files`；`installed` 必须不带该参数；运行 cwd 的所有父目录不得含 context file。
- 每个 trial 必须从全新 Git 状态开始，不能读取其他 trial 的 workspace、历史 patch 或 session。
- provider/网络/timeout 错误单独标记为 infrastructure error，不计为 Agent 失败，也不能静默从报告删除；修复环境后重跑同一 trial。
- dry run 和 oracle 验证不调用真实模型；真实 pilot 运行前再次向用户确认。
- pilot 报告明确标注 `n=1 per task-condition`，不得将 100%/0% 或成本差写成稳定结论。

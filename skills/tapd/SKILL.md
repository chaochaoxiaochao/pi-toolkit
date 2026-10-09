---
name: tapd
description: 通过 tapd CLI 查询和操作 TAPD 中的需求、缺陷、任务和 Wiki。用户提供 tapd.cn 链接，或要求分析、查询、创建、更新 TAPD 条目及其评论、变更、附件和关联提交时使用。
---

# TAPD

常用功能直接按下列命令执行；只有低频功能、写操作参数或版本差异不明确时才查看帮助。

## 基础功能

除 `tapd url`、认证和 `tapd workspace list` 外，以下命令都应携带目标 `--workspace-id=<id>`。`tapd workspace info` 读取当前 workspace，因此也需要已解析的 workspace；`tapd workspace switch <id>` 会修改当前目录配置。

| 任务 | 命令 |
|---|---|
| 根据链接读取需求、缺陷、任务或 Wiki | `tapd url '<tapd-url>'` |
| 查看当前/可用 workspace | `tapd workspace info` / `tapd workspace list` |
| 查看单条需求、缺陷、任务或 Wiki | `tapd story show <id>` / `tapd bug show <id>` / `tapd task show <id>` / `tapd wiki show <id>` |
| 查询需求、缺陷、任务或 Wiki | `tapd story list` / `tapd bug list` / `tapd task list` / `tapd wiki list` |
| 查看评论 | `tapd comment list --entry-id=<id> --entry-type=<stories|bug|tasks|wiki>` |
| 查看变更历史 | `tapd change list --entity-id=<id> --type=<story|bug|task>` |
| 查看附件 | `tapd attachment list --entry-id=<id> --type=<story|bug|task>` |
| 获取附件/内嵌图片下载描述 | `tapd attachment download --id=<attachment-id>` / `tapd image get --image-path=<path>` |
| 查看需求关联缺陷/缺陷关联需求 | `tapd relation bugs --story-id=<id>` / `tapd bug related-stories --bug-id=<id>` |
| 查看关联提交 | `tapd source list --object-id=<id> --type=<story|bug|task>` |
| 获取工作项类型 ID | `tapd workitem-type list` |
| 查询工作流状态与流转 | `tapd workflow status-map --system=<story|bug> --workitem-type-id=<id>` / `tapd workflow transitions --system=<story|bug> --workitem-type-id=<id>` |
| 创建或更新条目 | `tapd <story|bug|task|wiki> create ...` / `tapd <story|bug|task|wiki> update <id> ...` |
| 添加评论 | `tapd comment add --entry-id=<id> --entry-type=<stories|bug|tasks|wiki> --description='<text>'` |

常用全局参数：

- `--workspace-id=<id>`：指定本次调用的 workspace；调查链接时优先显式传递。
- `--json`：让详情命令输出 JSON，适合提取字段；列表通常已经输出 JSON。
- `--no-comments`：读取详情时省略评论。
- `--pretty`：仅供人工阅读；Agent 解析时不使用。

列表命令可用 `--limit`、`--page`、`--order` 和实体特有字段缩小结果。仅在普通参数不能表达条件时使用 `--filter`；操作符和字段以当前叶级帮助为准。

## 版本差异与低频命令

基础功能优先使用上表，不从完整命令树开始试错。出现以下情况时再查看帮助：

1. 运行 `tapd <group> --help` 查看该组有哪些能力。
2. 运行 `tapd <group> <command> --help` 确认低频参数或写操作的必填字段。
3. 仅在不知道命令组名称或全局参数发生变化时运行 `tapd --help`。

不要通过缺省参数执行命令来探测语法；部分命令会使用默认值直接产生写操作。

认证失败时按 CLI 提示配置凭据。不要把 token、临时下载 URL 或其他凭据写进仓库、日志或最终答复。

## Workspace 契约

`tapd url <url>` 会从 URL 解析 workspace 和条目，不需要预先配置 workspace。`tapd workspace list` 也不需要 workspace；`tapd workspace info` 和其他业务命令需要。每个独立的 `tapd` 进程都必须解析到目标 workspace：

- 调查 URL 时，记录 URL 对应的 workspace ID，并在后续每条命令显式传 `--workspace-id=<id>`。
- 只有用户明确要求持久切换项目时才运行 `tapd workspace switch <id>`；它会在当前目录写入 `.tapd.json`，切换目录后不能假设仍然生效。
- 也可使用已配置的 `TAPD_WORKSPACE_ID`，但先确认它与目标 URL 一致。

一条命令成功不代表下一进程继承了 workspace。收到 `workspace_required` 时，根据目标 URL 或用户选择补齐 workspace 后重试。

## 调查 TAPD URL

1. **识别条目**：运行 `tapd url '<url>'`，记录 workspace ID、实体类型、实体 ID、标题、状态和正文。
2. **收集证据**：直接使用基础功能表中的命令，按实体类型检查详情及评论、变更历史、附件、正文或评论中的图片、关联需求/缺陷以及关联提交；每条命令显式传播 workspace ID。只有所需能力未列出、参数不明确或当前版本拒绝已记录语法时才查看叶级帮助。
3. **读取附件**：先列出附件，再获取相关附件或图片的下载描述。下载前必须完整阅读 [附件与图片](references/attachment-download.md)。将下载后的文件交给当前环境可用的文件或图片读取能力；外部 OCR 仅在确认已安装时使用。没有可用的图片读取或 OCR 能力时明确报告阻塞，不能声称已检查图片内容。
4. **定位代码**：从产品、版本、模块、时间、日志关键词和关联提交定位相关代码。把 TAPD 事实、代码事实和推断分开记录。
5. **给出结论**：说明现象、影响范围、最可能原因及证据；证据不足时列出缺失日志、版本、附件或复现条件，不把推断写成事实。

### 调查完成标准

仅当以下各项均已检查或明确标记“不适用/无法获取”时结束：

- 条目详情和评论；
- 变更历史；
- 附件及内嵌图片；
- 关联需求、缺陷和提交；
- 与结论相关的代码路径；
- 已确认事实、推断和阻塞项。

## JSON 输出契约

- 使用 JSON 解析器解析 JSON；不要用 `sed`、`grep` 或正则假设键的排版。
- `attachment download` 和 `image get` 返回 JSON 下载描述，不返回文件内容。使用本 Skill 的 `scripts/extract-download-url.mjs` 读取其中的 `download_url`；它必须存在且使用 `https://`。
- 不确定输出结构时先保存并检查一次真实输出，或运行带 mock 数据的最小命令；不要编造字段层级。

## 写操作

创建、更新、评论、关联或流转条目前：

1. 读取当前条目和叶级 `--help`。
2. 工作流状态先用 `tapd workitem-type list` 获取类型 ID，再用表中的 `tapd workflow` 命令查询，不猜状态值。
3. 展示将修改的条目、字段和值；用户未明确授权写入时只给建议。
4. 执行最小写操作，并立即重新读取目标条目验证服务端结果。

批量、删除或不可逆操作必须先确认精确范围。完成标准是服务端读回结果符合预期，而不是命令仅返回成功。


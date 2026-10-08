export const incidentCases = [
  {
    id: "incident-repeated-markdown-context",
    protocolCaseId: "repeated-markdown-separator",
    tier: "agent-and-protocol",
    issue: "重复 Markdown 分隔符曾触发 ambiguous match",
    prompt: "更新 SKILL.md 的 frontmatter 描述，并在 frontmatter 结束分隔符后插入指定说明；不要改动正文和页脚。",
  },
  {
    id: "incident-repeated-update-same-path",
    protocolCaseId: "repeated-update-same-path",
    tier: "protocol-only",
    issue: "同一个 raw path 的多个 Update File 块在发布版中冲突",
    prompt: "验证同一次 apply_patch 调用中，同一路径的多个普通 Update File 块可以按顺序以上一块结果为输入。",
  },
  {
    id: "incident-runner-type-rename",
    protocolCaseId: "ordered-runner-type-renames",
    tier: "agent-and-protocol",
    issue: "runner.ts 中重复类型名的大范围重命名曾触发 ambiguous match",
    prompt: "将 packages/herdr-subagents/src/runner.ts 中 TinySubagent 系列公开类型和引用完整重命名为 HerdrSubagents，保持其余代码逐字不变。",
  },
  {
    id: "incident-multi-file-structural-edit",
    protocolCaseId: "multi-file-add-delete-move",
    tier: "agent-and-protocol",
    issue: "一次 patch 中的 add/delete/move 需要原子预校验和执行",
    prompt: "按要求移动并更新 old.ts，删除 remove.txt，再创建 added.txt；不要留下额外文件。",
  },
  {
    id: "incident-bom-crlf",
    protocolCaseId: "bom-and-crlf",
    tier: "agent-and-protocol",
    issue: "UTF-8 BOM 与 CRLF 曾导致原生精确文本匹配失败",
    prompt: "只修改 app.ts 中的目标标识符，同时逐字保留 UTF-8 BOM、CRLF 和未指定行。",
  },
];

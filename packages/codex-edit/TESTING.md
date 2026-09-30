# Codex Edit 测试方案

## 流程

1. `npm --prefix packages/codex-edit test`：运行 parser、matcher、路由和包结构测试。
2. `pi -ne -e ./packages/codex-edit/extensions/codex-edit.ts`：加载权威入口；独立子包与根包 manifest 都指向该实现。
3. `npm pack ./packages/codex-edit --dry-run`：检查独立 tarball。
4. 确认 README 的协议示例、真实 parser 运行输出 `docs/screenshot.png` 和 `docs/demo.gif` 随包发布。

## 用例数据

- Add/Delete/Update/Move、多 hunk、BOM、CRLF、EOF 和 workspace escape。
- 与 Codex 一致的 cursor 顺序匹配：重复 HTML section 与 Markdown `---`。
- 多文件结构重构 patch 的解析，以及重复目标拒绝。
- `gpt-5.6-*` glob、Responses API 路由和 disabled 配置。
- 自定义精确规则与 `*` glob；相同 model ID 在不支持的 API 上必须回退到 Pi `edit`。

## 最近验证结果

当前基线为 12 个确定性测试全部通过；真实触发过 `Ambiguous ... regions found` 的重复 HTML/Markdown 形态已经加入回归集。发布前必须验证子包 tarball 和根包 tarball 都包含该入口。

# Cache Export 测试方案

## 流程

1. `npm --prefix packages/cache-export test`：先运行确定性逻辑测试，再运行真实 Chromium E2E。
2. `npm --prefix packages/cache-export run load-test`：加载扩展入口。
3. `npm pack ./packages/cache-export --dry-run`：检查 tarball。
4. 确认 Tau 来源说明、功能示例、真实浏览器截图 `docs/screenshot.png` 和 `docs/demo.gif` 随包发布。

## 用例数据

- 47 个确定性断言：命中率阈值、TTL、cache rebuild、模型切换、compaction、segment 和退化输入。
- 18 个浏览器断言：三张图的 tooltip、断点两侧、全历史视图、segment 全局请求号和浏览器异常。

## 最近验证结果

迁移前基线为 `47 passed, 0 failed` 和 `18 passed, 0 failed, 0 skipped`。找不到 Chrome 时 E2E 会明确报告 skip；发布验收要求可用 Chrome 的环境中 0 skip。

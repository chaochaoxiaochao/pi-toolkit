# Cache Export 测试方案

## 流程

1. `npm --prefix packages/cache-export test`：先运行确定性逻辑测试，再运行真实 Chromium E2E。
2. `npm --prefix packages/cache-export run load-test`：加载扩展入口。
3. `npm pack ./packages/cache-export --dry-run`：检查 tarball。
4. 确认 Tau 来源说明、功能示例、真实浏览器截图 `docs/screenshot.png` 和 `docs/demo.gif` 随包发布。

## 用例数据

- 47 个基础确定性断言：命中率阈值、保留期未知、可能原因、模型切换、compaction、segment 和退化输入。
- `tests/evidence.mjs`：慢响应不冒充空闲、历史策略缺失/混合 TTL、不传播推算到期、真实保温 usage、context_edit、reasoning 未知、白名单无秘密、相对 cwd。
- `tests/extension.mjs`：真实 Pi SDK、离线 provider 的 payload hook、assistant 关联和 session-relative 导出。用 `PI_TEST_BINARY` 选 Pi 1.4.0。
- 21 个浏览器断言：原有 tooltip/断点/segment 验证，加真实 CDP 点击和键盘切换、主/辅助范围标签、Unknown reasoning 不画零线或零点。`CACHE_EXPORT_SCREENSHOT_DIR` 可保留真实截图。

## 最近验证结果

迁移前基线为 `47 passed, 0 failed` 和 `18 passed, 0 failed, 0 skipped`。找不到 Chrome 时 E2E 会明确报告 skip；发布验收要求可用 Chrome 的环境中 0 skip。

验证依据是输入 usage 与渲染结果、真实 SDK 事件和 Chrome 行为；不是 Pi 自带缓存推断，更不是对服务端实际 TTL 的校准。

混合 TTL 回归同时包含 `cacheWrite1h` 为零、部分写入及全部写入的情况；所有已知混合策略均保持请求级 Unknown。只有写入计数揭示混合、没有 payload 历史时也不得推断为单一 1h。

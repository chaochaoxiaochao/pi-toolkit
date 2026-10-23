# @maxiaochao/pi-cache-export

Pi 的 `/cache_export [path]` 扩展，把当前会话写成可交互的缓存诊断 HTML。

![Cache Export 真实 Web 仪表盘截图](docs/screenshot.png)

## 为什么有这个包

这个功能对齐 [Hugging Face Tau](https://github.com/huggingface/tau) coding agent 的 session usage / cache dashboard。`src/tau-assets.ts` 与仪表盘基础逻辑来自 Tau 的 `tau_coding/session_usage.py`，本包把它适配到 Pi session，并增加：

- Pi 消息、tool result、模型切换和 compaction 解析。
- 按 Context segment 查看最新上下文、历史 segment 或全部历史。
- cache miss、TTL expiry、cache rebuild 和低命中 streak 诊断。
- 跨图表断点的 tooltip，以及 segment 内的全局请求编号。

Tau 资产保持上游一致；上述 Pi 语义和诊断规则由本包维护。

## 演示

![导出缓存仪表盘演示](docs/demo.gif)

```text
/cache_export
/cache_export ./reports/cache.html
/cache_export --open
```

命令读取当前 session，生成自包含 HTML；`--open` 在支持的桌面环境中同时打开浏览器。

## 安装

完整工具包已经包含本扩展：

```bash
pi install npm:@maxiaochao/pi-toolkit
```

只需要缓存仪表盘时单独安装：

```bash
pi install npm:@maxiaochao/pi-cache-export
```

两种方式二选一，避免重复注册。

## 更新

```bash
pi update npm:@maxiaochao/pi-toolkit       # 更新主包内置版本
pi update npm:@maxiaochao/pi-cache-export  # 更新独立子包
```

两个 npm 包版本独立。Cache Export 源码变更需要分别发布主包和子包，才能覆盖两类用户。

## 功能

- 默认展示最新 Context segment，也可切换历史 segment 或全部历史。
- 模型切换和 compaction 切分 segment。
- 诊断 cache miss、TTL、cache rebuild 和低命中 streak。
- 导出的 HTML 自包含，可离线查看。

## 开发与测试

权威源码位于 `extensions/` 和 `src/`。`src/tau-assets.ts` 必须由上游资产重生成，禁止手改。测试流程、数据用例和结果见 [TESTING.md](TESTING.md)。

```bash
npm --prefix packages/cache-export test
npm --prefix packages/cache-export run load-test
npm pack ./packages/cache-export --dry-run
```

## 数据与证据口径

主曲线只包含当前分支的主对话 assistant usage。保温、压缩等辅助 usage 单独列出，不计入主曲线或主对话合计。保温只认已完成的 `usage/cache_warm` 记录，不把准备事件当成功。

命中率是服务商/Pi 报告的 `cacheRead / (input + cacheRead + cacheWrite)`，不是服务端缓存状态探针。横轴是请求序号；模型切换、压缩和 `context_edit` 等上下文变更会分段，累计曲线标为 segment cumulative。分段首条不等于会话冷启动。

请求开始取 `message.timestamp`，响应耗时取 `durationMs`；落盘时间另列，不充当请求开始或空闲时间。未报告的时间、reasoning、保留期显示 Unknown。

扩展从启用后的 `before_provider_request` 观察已知 retention/TTL 枚举和模型 `promptCache` 参考值，在对应 assistant 消息结束时写入 `cache-export-request` 自定义记录。只存非秘密白名单字段；不存提示词、cache key、headers、URL 或凭据。不用当前配置补历史；hook 之后其他扩展仍可能修改请求。这些值只表示观察到的请求/策略参考，不证明服务端采用、续期或到期。混合 TTL、缺字段或未记录历史保持未知，不套用通用 5 分钟，也不把 OpenAI 公共 API 的期限直接套给 Codex 订阅接口。

已观察 usage/上下文事件、策略参考和可能原因分开表述。Pi 自带的缓存推断不是服务端真值，也不是本报告的校准标准。

相对输出路径以当前 Pi session 的 cwd 为基准（包括切换后的 worktree）。

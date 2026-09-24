---
name: tapd
description: TAPD操作，涉及需求，缺陷，任务，Wiki等。tapd.cn快捷查询：tapd url <url>
---

面向 AI Agent 的 TAPD 命令行工具。通过 `tapd` 命令与 TAPD 平台交互，所有输出针对最小 token 消耗优化。

## 安装

```bash
go install github.com/studyzy/tapd-ai-cli/cmd/tapd@latest
```

## 认证

```bash
# Access Token（推荐）
export TAPD_ACCESS_TOKEN=<your_token>

# 或交互式登录持久化凭据
tapd auth login
```

凭据优先级：CLI flags > 环境变量 > `./.tapd.json` > `~/.tapd.json`

## 高级过滤（--filter）

所有 `list` 命令均支持 `--filter` 标志，可重复使用，直接透传 TAPD OpenAPI 的高级查询语法：

```bash
tapd story list --filter "name=LIKE<登录>" --filter "status=EQ<已实现>"
tapd bug list --filter "created=>2024-01-01" --filter "custom_field_one=EQ<高优先级>"
tapd task list --filter "owner=USER_OR<张三|李四>"
```

### 支持的操作符

| 操作符 | 含义 | 示例 |
|--------|------|------|
| `LIKE<value>` | 模糊匹配 | `name=LIKE<登录>` |
| `EQ<value>` | 精确匹配 | `status=EQ<已实现>` |
| `NOT_EQ<value>` | 不等于 | `status=NOT_EQ<已关闭>` |
| `LIKE_OR<v1\|v2>` | 模糊匹配多个值（OR） | `name=LIKE_OR<登录\|注册>` |
| `CONTAINS<v1\|v2>` | 包含所有值（AND） | `label=CONTAINS<前端\|高优>` |
| `CONTAINS_OR<v1\|v2\|v3>` | 包含任一值（OR） | `status=CONTAINS_OR<开发中\|测试中>` |
| `USER_OR<u1\|u2>` | 多人查询（OR） | `owner=USER_OR<张三\|李四>` |
| `>` / `<` | 大于/小于（时间/数值） | `created=>2024-01-01` |
| `~` | 时间范围 | `created=2024-01-01~2024-12-31` |
| `\|` | 多值 OR | `status=开发中\|测试中` |
| `<>` | 不等于（简写） | `status=<>已关闭` |

### 适用字段

- 标准字段（name/title/status/owner/created 等）
- 自定义字段（custom_field_one、custom_field_two 等，用 `custom-field list --entity-type stories` 查看可用字段）

`--filter` 与已有标志（`--status`、`--owner` 等）可组合使用，参数会合并传递给 API。

## 命令参考

### url — 根据 TAPD URL 查询对应条目详情（支持需求、缺陷、任务、Wiki）

```bash
tapd url <url>  # 根据 TAPD URL 查询对应条目详情（支持需求、缺陷、任务、Wiki）
```

### story — 需求管理

```bash
tapd story count [--status=<用 workflow status-map 查询可用值>]  # 查询需求数量
tapd story create [--begin=<格式：2006-01-02>] [--category-id] [--cc] [--custom-field=<可重复，格式：key=value>] [--description=<text>|--file=<path>|stdin] [--developer] [--due=<格式：2006-01-02>] [--iteration-id] [--label=<多个以竖线分隔>] --name=<必需> [--owner] [--parent-id=<创建子需求时使用>] [--priority=<High/Middle/Low/Nice To Have>]  # 创建需求
tapd story list [--category-id] [--fields=<逗号分隔，如 "id,name,status,module">] [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--iteration-id] [--label] [--limit=10] [--name] [--order=<如 "created desc">] [--owner] [--page=1] [--priority] [--status=<用 workflow status-map 查询可用值>]  # 查询需求列表
tapd story show <story_id>  # 查看需求详情
tapd story todo [--limit=10] [--page=1]  # 查询当前用户待办需求
tapd story update <story_id> [--begin=<格式：2006-01-02>] [--category-id] [--cc] [--current-user] [--custom-field=<可重复，格式：key=value>] [--description=<text>|--file=<path>|stdin] [--developer] [--due=<格式：2006-01-02>] [--iteration-id] [--label=<多个以竖线分隔>] [--name] [--owner] [--priority=<High/Middle/Low/Nice To Have>] [--status=<用 workflow status-map 查询可用值>]  # 更新需求
```

### comment — 评论管理

```bash
tapd comment add [--author=<可选，默认使用当前登录用户>] [--description=<text>|--file=<path>|stdin] --entry-id=<必需> --entry-type=<stories|bug|bug_remark|tasks|wiki> [--reply-id=<可选>]  # 添加评论
tapd comment count [--entry-id] [--entry-type=<stories|bug|bug_remark|tasks|wiki>]  # 查询评论数量
tapd comment list [--author] [--entry-id] [--entry-type=<stories|bug|bug_remark|tasks|wiki>] [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--limit=10] [--order=<如 created desc>] [--page=1]  # 查询评论列表
tapd comment update <comment_id> [--description=<text>|--file=<path>|stdin]  # 更新评论
```

### task — 任务管理

```bash
tapd task count [--status=<open/progressing/done>]  # 查询任务数量
tapd task create [--begin=<格式：2006-01-02>] [--cc] [--custom-field=<可重复，格式：key=value>] [--description=<text>|--file=<path>|stdin] [--due=<格式：2006-01-02>] [--effort] [--iteration-id] [--label=<多个以竖线分隔>] --name=<必需> [--owner] [--priority=<High/Middle/Low/Nice To Have>] [--story-id]  # 创建任务
tapd task list [--fields=<逗号分隔，如 "id,name,status,module">] [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--iteration-id] [--label] [--limit=10] [--name] [--order=<如 "created desc">] [--owner] [--page=1] [--priority] [--status=<open/progressing/done>] [--story-id]  # 查询任务列表
tapd task show <task_id>  # 查看任务详情
tapd task todo [--limit=10] [--page=1]  # 查询当前用户待办任务
tapd task update <task_id> [--begin=<格式：2006-01-02>] [--cc] [--current-user] [--custom-field=<可重复，格式：key=value>] [--description=<text>|--file=<path>|stdin] [--due=<格式：2006-01-02>] [--effort] [--iteration-id] [--label=<多个以竖线分隔>] [--name] [--owner] [--priority=<High/Middle/Low/Nice To Have>] [--status=<open/progressing/done>] [--story-id]  # 更新任务
```

### bug — 缺陷管理

```bash
tapd bug count [--status=<用 workflow status-map 查询可用值>]  # 查询缺陷数量
tapd bug create [--begin=<格式：2006-01-02>] [--cc] [--current-owner] [--custom-field=<可重复，格式：key=value>] [--description=<text>|--file=<path>|stdin] [--due=<格式：2006-01-02>] [--iteration-id] [--label=<多个以竖线分隔>] [--module] [--priority=<urgent/high/medium/low/insignificant>] [--severity=<fatal/serious/normal/prompt/advice>] --title=<必需>  # 创建缺陷
tapd bug list [--fields=<逗号分隔，如 "id,title,status,module">] [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--iteration-id] [--label] [--limit=10] [--module] [--order=<如 "created desc">] [--owner] [--page=1] [--priority=<urgent/high/medium/low/insignificant>] [--reporter] [--severity=<fatal/serious/normal/prompt/advice>] [--status=<用 workflow status-map 查询可用值>] [--title]  # 查询缺陷列表
tapd bug show <bug_id>  # 查看缺陷详情
tapd bug todo [--limit=10] [--page=1]  # 查询当前用户待办缺陷
tapd bug update <bug_id> [--begin=<格式：2006-01-02>] [--cc] [--current-user] [--custom-field=<可重复，格式：key=value>] [--description=<text>|--file=<path>|stdin] [--due=<格式：2006-01-02>] [--label=<多个以竖线分隔>] [--module] [--owner=<current_owner>] [--priority=<urgent/high/medium/low/insignificant>] [--resolution] [--severity=<fatal/serious/normal/prompt/advice>] [--status=<用 workflow status-map 查询可用值>] [--title]  # 更新缺陷
```

### attachment — 附件管理

```bash
tapd attachment list --entry-id=<必需> [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--limit=10] [--page=1] [--type=<story|bug|task>]  # 查询条目的附件列表
```

### auth — 认证管理

```bash
tapd auth login [--local]  # 登录并持久化凭据到配置文件
```

### category — 需求分类管理

```bash
tapd category list [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--name=<支持模糊匹配，如 %搜索词%>]  # 查询需求分类列表
```

### commit-msg — 源码提交关键字管理

```bash
tapd commit-msg get --object-id=<必需> [--type=<story|task|bug>]  # 获取源码提交关键字（用于关联 git commit 到 TAPD 条目）
```

### custom-field — 自定义字段管理

```bash
tapd custom-field list --entity-type=<stories|tasks|iterations|tcases> [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>]  # 获取自定义字段配置
```

### image — 图片管理

```bash
tapd image get --image-path=<必需，从条目描述中获取>  # 获取图片下载链接
```

### iteration — 迭代管理

```bash
tapd iteration count [--status=<open/done>]  # 查询迭代数量
tapd iteration create --creator=<必需> [--description] --enddate=<必需，格式：2006-01-02> [--label=<多个以竖线分隔>] --name=<必需> [--parent-id] --startdate=<必需，格式：2006-01-02> [--status=<open/done，默认 open>]  # 创建迭代
tapd iteration list [--creator] [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--limit=10] [--name] [--order=<如 "created desc">] [--page=1] [--status=<open/done>]  # 查询迭代列表
tapd iteration update <iteration_id> --current-user=<必需> [--description] [--enddate=<格式：2006-01-02>] [--name] [--startdate=<格式：2006-01-02>] [--status=<open/done>]  # 更新迭代
```

### qiwei — 企业微信消息管理

```bash
tapd qiwei send --msg=<Markdown 格式> --webhook=<必需，也可通过 BOT_URL 环境变量设置>  # 发送消息到企业微信群（通过机器人 Webhook）
```

### relation — 关联关系管理

```bash
tapd relation bugs --story-id=<必需>  # 查询需求关联的缺陷
tapd relation create --source-id=<必需> --source-type=<story|bug|task> --target-id=<必需> --target-type=<story|bug|task>  # 创建实体关联关系
```

### release — 发布计划管理

```bash
tapd release list [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>]  # 查询发布计划列表
```

### skill — AI Coding 工具 Skill 管理

```bash
tapd skill init  # 为 AI Coding 工具生成 TAPD CLI 的 SKILL.md
```

### story-field — 需求字段信息

```bash
tapd story-field info  # 获取需求字段及候选值
tapd story-field label  # 获取需求字段中英文名
```

### tcase — 测试用例管理

```bash
tapd tcase batch-create --tcases=<必需>  # 批量创建测试用例
tapd tcase create [--creator] [--expectation] [--id=<有值时为更新，无值时为创建>] --name=<创建时必需> [--precondition] [--priority=<high/medium/low>] [--status=<updating|abandon|normal>] [--steps] [--type=<functional/performance/other>]  # 创建或更新测试用例
tapd tcase list [--creator] [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--limit=10] [--page=1] [--priority=<high/medium/low>] [--status=<updating|abandon|normal>]  # 查询测试用例列表
```

### timesheet — 花费工时管理

```bash
tapd timesheet add --entity-id=<必需> --entity-type=<story|task|bug> [--memo=<可选>] [--owner=<可选，默认当前用户>] [--spentdate=<可选>] [--timeremain=<可选>] --timespent=<必需>  # 填写花费工时
tapd timesheet list [--entity-id] [--entity-type=<story|task|bug>] [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--limit=10] [--owner] [--page=1]  # 查询花费工时列表
tapd timesheet update <timesheet_id> [--memo] [--timeremain] [--timespent]  # 更新花费工时
```

### wiki — Wiki 文档管理

```bash
tapd wiki create [--content=<Markdown 格式>] --creator=<必需> [--file] --name=<必需> [--note] [--parent-wiki-id]  # 创建 Wiki 文档
tapd wiki list [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--limit=10] [--name] [--page=1]  # 查询 Wiki 文档列表
tapd wiki show <wiki_id>  # 查看 Wiki 文档详情
tapd wiki update <wiki_id> [--content=<Markdown 格式>] [--file] [--name] [--note] [--parent-wiki-id]  # 更新 Wiki 文档
```

### workflow — 工作流状态管理

```bash
tapd workflow last-steps --system=<story|bug> [--workitem-type-id]  # 获取结束状态
tapd workflow status-map --system=<story|bug> --workitem-type-id=<必需>  # 获取状态中英文映射
tapd workflow transitions --system=<story|bug> --workitem-type-id=<必需>  # 获取状态流转规则
```

### workitem-type — 需求类别管理

```bash
tapd workitem-type list [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--limit=30] [--name] [--page=1]  # 获取需求类别列表
```

### workspace — 工作区管理

```bash
tapd workspace info  # 查看当前工作区详情
tapd workspace list  # 列出参与的项目
tapd workspace switch <workspace_id>  # 切换当前工作区（写入当前目录 .tapd.json）
```

### story — 需求管理

```bash
tapd story batch-update [--current-user] --ids=<逗号分隔> [--owner] [--priority] [--status]  # 批量更新需求
tapd story copy <story_id> [--current-user]  # 复制需求
tapd story link add --story-id=<必需> --target-id=<必需>  # 创建需求关联关系
tapd story link list --story-id=<必需>  # 查询需求关联关系
tapd story link remove --story-id=<必需> --target-id=<必需>  # 解除需求关联关系
tapd story removed [--limit=<默认 30，最大 200>] [--page]  # 查询回收站中的需求
tapd story template list [--workitem-type-id]  # 查询需求模板列表
tapd story time-relation delete --current-user=<必需> --related-id=<必需> --story-id=<必需>  # 删除需求前后置关系
tapd story time-relation list --story-id=<必需>  # 查询需求前后置关系
```

### task — 任务管理

```bash
tapd task batch-update [--current-user] --ids=<逗号分隔> [--owner] [--status]  # 批量更新任务
tapd task removed [--limit=<默认 30，最大 200>] [--page]  # 查询回收站中的任务
```

### bug — 缺陷管理

```bash
tapd bug batch-update [--current-user] --ids=<逗号分隔> [--owner] [--status]  # 批量更新缺陷
tapd bug copy <bug_id> [--current-user]  # 复制缺陷
tapd bug link add --bug-id=<必需> --target-bug-ids=<多个以逗号分隔>  # 创建缺陷关联关系
tapd bug link list --bug-id=<必需>  # 查询缺陷关联关系
tapd bug link remove --bug-id=<必需> --link-ids=<多个以逗号分隔>  # 取消缺陷关联关系
tapd bug related-stories --bug-id=<必需>  # 查询缺陷关联的需求
tapd bug removed [--limit=<默认 30，最大 200>] [--page]  # 查询回收站中的缺陷
tapd bug template list  # 查询缺陷模板列表
```

### app-version — 版本管理

```bash
tapd app-version count  # 查询版本数量
tapd app-version create --creator=<必需> [--description] --name=<必需>  # 创建版本
tapd app-version list [--limit=30] [--name] [--page=1] [--status=<Closed/Unclosed>]  # 查询版本列表
tapd app-version update <version_id> [--description] --modifier=<必需> [--name]  # 更新版本
```

### attachment — 附件管理

```bash
tapd attachment download --id=<必需>  # 获取附件下载链接
tapd attachment upload --custom-field=<必需> --entry-id=<必需> --file=<必需> --type=<如 story_custom_field>  # 上传附件
```

### baseline — 基线管理

```bash
tapd baseline count  # 查询基线数量
tapd baseline create [--description] [--name] [--version-id]  # 创建基线
tapd baseline list [--limit=30] [--name] [--page=1]  # 查询基线列表
tapd baseline update <baseline_id> [--description] [--name]  # 更新基线
```

### category — 需求分类管理

```bash
tapd category count  # 查询需求分类数量
tapd category create [--description] --name=<必需> [--parent-id]  # 创建需求分类
tapd category update <category_id> [--description] [--name]  # 更新需求分类
```

### change — 变更历史管理

```bash
tapd change count [--entity-id] --type=<story|bug|task>  # 查询变更数量
tapd change list --entity-id=<迭代变更时必需> [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--limit=10] [--page=1] --type=<story|bug|task|iteration>  # 查询变更历史
```

### feature — 特性管理

```bash
tapd feature count  # 查询特性数量
tapd feature create [--description] --name=<必需>  # 创建特性
tapd feature list [--limit=30] [--name] [--page=1]  # 查询特性列表
tapd feature update <feature_id> [--description] [--name] [--owner]  # 更新特性
```

### image — 图片管理

```bash
tapd image upload --custom-field=<必需> --entry-id=<必需> --file=<必需，≤15MB>  # 以 base64 方式上传图片
```

### iteration — 迭代管理

```bash
tapd iteration lock <iteration_id> [--lock-types=<__ALL_STORY__/__ALL_BUG__，多个以逗号分隔>]  # 锁定迭代
tapd iteration unlock <iteration_id>  # 解锁迭代
```

### label — 标签管理

```bash
tapd label add [--color=<1|2|3|4>] --name=<必需，不能包含英文竖线>  # 创建标签
tapd label count [--name=<支持模糊匹配>]  # 查询标签数量
tapd label list [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--limit=<最大 200>] [--name=<支持模糊匹配>] [--page=1]  # 查询标签列表
tapd label update <label_id> [--color=<1|2|3|4>]  # 更新标签
```

### launch — 发布评审管理

```bash
tapd launch count [--creator] [--id] [--release-type] [--status=<initial/auditing/signing/sign_completed/finished；初始化/评审中/待签发/签发结束/发布结束>] [--title]  # 查询发布评审数量
tapd launch create [--alias-field=[]] [--archived-by] [--baseline] [--cc] [--creator=<默认当前用户>] [--custom-field=[]] [--release-model] [--release-type] [--roadmap-version] [--signed-by] --template-id=<必需> [--title] [--version-type]  # 创建发布评审
tapd launch fields  # 查询发布评审自定义字段配置
tapd launch list [--creator] [--fields=<逗号分隔>] [--id] [--limit=10] [--page=1] [--release-type] [--status=<initial/auditing/signing/sign_completed/finished；初始化/评审中/待签发/签发结束/发布结束>] [--title]  # 查询发布评审列表
tapd launch logs --id=<必需>  # 查询发布评审活动日志
tapd launch templates  # 查询发布评审模板
tapd launch update <launch_form_id> [--alias-field=[]] [--archived-by] [--baseline] [--cc] [--change-notifier] [--change-type] [--custom-field=[]] [--release-comment] [--release-model] [--release-result=<release_success/release_fail>] [--release-type] [--remark] [--roadmap-version] [--signed-by] [--signer-comment] [--status=<initial/auditing/signing/sign_completed/finished；初始化/评审中/待签发/签发结束/发布结束>] [--title] [--version-type]  # 更新发布评审
```

### module — 模块管理

```bash
tapd module count  # 查询模块数量
tapd module create [--description] --name=<必需> [--owner]  # 创建模块
tapd module list [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--limit=30] [--name] [--page=1]  # 查询模块列表
tapd module update <module_id> [--description] [--name] [--owner]  # 更新模块
```

### release — 发布计划管理

```bash
tapd release count  # 查询发布计划数量
tapd release create [--description] --enddate=<格式：2006-01-02> --name=<必需> --startdate=<格式：2006-01-02>  # 创建发布计划
tapd release update <release_id> [--enddate=<格式：2006-01-02>] [--name] [--startdate=<格式：2006-01-02>] [--status]  # 更新发布计划
```

### report — 项目报告管理

```bash
tapd report list [--limit=30] [--page=1]  # 查询项目报告列表
```

### source — 源码提交关联管理

```bash
tapd source add [--author] [--commit-id] [--commit-time] [--commit-url] [--files=<逗号分隔>] --message=<必需> [--repo] [--repo-id] [--web-url]  # 保存 Commit 提交数据
tapd source list --object-id=<必需> --type=<必需>  # 获取 GIT 关联提交数据
tapd source objects --commit-id=<必需，支持逗号分隔多个> --type=<必需>  # 获取指定 commit 关联的 TAPD 业务对象
```

### tcase — 测试用例管理

```bash
tapd tcase update <tcase_id> [--expectation] [--name] [--precondition] [--priority=<high/medium/low>] [--status=<updating|abandon|normal>] [--steps]  # 更新测试用例
```

### test-plan — 测试计划管理

```bash
tapd test-plan bugs --id=<必需>  # 查询测试计划关联的缺陷
tapd test-plan count [--status]  # 查询测试计划数量
tapd test-plan create [--description] [--end-date] [--iteration-id] --name=<必需> [--owner] [--start-date]  # 创建测试计划
tapd test-plan list [--filter=<可重复，格式：field=OP<value>，支持 LIKE/EQ/CONTAINS 等 OpenAPI 特殊查询语法>] [--limit=10] [--name] [--page=1] [--status]  # 查询测试计划列表
tapd test-plan progress --id=<必需>  # 查询测试计划执行进度
tapd test-plan tcases --id=<必需> [--limit=30] [--page=1]  # 查询测试计划关联的测试用例
tapd test-plan update <test_plan_id> [--description] [--name] [--owner] [--status]  # 更新测试计划
```

### testx — TAPD testx 模块（用例/计划/报告/设计）

```bash
tapd testx case batch-bind-bug --case-uid=<必填> [--data=<用于填充 body 字段>] --repo-uid=<必填> --repo-version-uid=<必填>  # 批量关联 Bug
tapd testx case batch-create [--data=<用于填充 body 字段>] --repo-uid=<必填> --repo-version-uid=<必填>  # 批量创建用例
tapd testx case batch-unbind-bug --case-uid=<必填> [--data=<用于填充 body 字段>] --repo-uid=<必填> --repo-version-uid=<必填>  # 批量解绑 Bug
tapd testx case batch-update [--data=<用于填充 body 字段>] --repo-uid=<必填> --repo-version-uid=<必填>  # 批量更新用例
tapd testx case create [--data=<用于填充 body 字段>] --repo-uid=<必填> --repo-version-uid=<必填>  # 创建用例
tapd testx case folder-create [--data=<用于填充 body 字段>] --repo-uid=<必填> --repo-version-uid=<必填>  # 创建用例目录
tapd testx case folder-update [--data=<用于填充 body 字段>] --folder-uid=<必填> --repo-uid=<必填> --repo-version-uid=<必填>  # 更新用例目录
tapd testx case list-bug --case-uid=<必填> [--data=<用于填充 body 字段>] [--handler] [--limit] [--name] [--offset] [--priority] --repo-uid=<必填> --repo-version-uid=<必填> [--status]  # 用例关联缺陷列表
tapd testx case list-execution --case-uid=<必填> [--data=<用于填充 body 字段>] [--limit] [--offset] [--ordering] --repo-uid=<必填> --repo-version-uid=<必填>  # 用例执行记录
tapd testx case list-history --case-uid=<必填> [--data=<用于填充 body 字段>] [--limit] [--offset] --repo-uid=<必填> --repo-version-uid=<必填>  # 用例变更历史
tapd testx case list-review --case-uid=<必填> [--data=<用于填充 body 字段>] [--is-last-review] [--limit] [--main-uid] [--offset] --repo-uid=<必填> --repo-version-uid=<必填> [--source] [--source-kind] [--source-uid]  # 用例评审记录
tapd testx case list-template [--data=<用于填充 body 字段>]  # 用例模板列表
tapd testx case repo-create [--data=<用于填充 body 字段>]  # 创建用例仓库
tapd testx case repo-get [--data=<用于填充 body 字段>] --repo-uid=<必填>  # 获取用例仓库
tapd testx case repo-list [--data=<用于填充 body 字段>] [--limit] [--offset] [--reverse] [--search]  # 获取用例仓库列表
tapd testx case repo-update [--data=<用于填充 body 字段>] --repo-uid=<必填>  # 更新用例仓库
tapd testx case search [--data=<用于填充 body 字段>] [--limit] [--offset] --repo-uid=<必填> --repo-version-uid=<必填>  # 搜索用例
tapd testx case update --case-uid=<必填> [--data=<用于填充 body 字段>] --repo-uid=<必填> --repo-version-uid=<必填>  # 更新用例
tapd testx design list-labels [--design-uid] [--kind] [--name]  # 测试设计标签
tapd testx design list-stat [--data=<用于填充 body 字段>]  # 测试设计统计
tapd testx design search [--data=<用于填充 body 字段>]  # 搜索测试设计
tapd testx plan batch-archive [--data=<用于填充 body 字段>]  # 批量归档计划
tapd testx plan batch-update-case [--data=<用于填充 body 字段>] --plan-uid=<必填>  # 批量更新计划用例
tapd testx plan bind-bug [--data=<用于填充 body 字段>] --plan-uid=<必填>  # 计划用例批量关联缺陷
tapd testx plan bug-statistics [--data=<用于填充 body 字段>]  # 计划关联缺陷统计
tapd testx plan create [--data=<用于填充 body 字段>]  # 创建计划
tapd testx plan folder-children [--data=<用于填充 body 字段>] [--item-type] [--name] [--plan-archive] [--plan-states=<可重复>] --uid=<必填> [--with-ancestor] [--with-descendant]  # 获取目录子信息
tapd testx plan folder-create [--data=<用于填充 body 字段>]  # 创建计划目录
tapd testx plan folder-update [--data=<用于填充 body 字段>] --folder-uid=<必填>  # 更新计划目录
tapd testx plan get [--data=<用于填充 body 字段>] --uid=<必填> [--with-detail] [--with-statistic]  # 获取计划详情
tapd testx plan list [--data=<用于填充 body 字段>] --folder-uid=<必填>  # 目录下计划列表
tapd testx plan list-bugs [--bug-id] [--data=<用于填充 body 字段>] [--limit] [--offset] --plan-uid=<必填> [--related-types=<多个用逗号分隔>] [--status] [--summary]  # 计划关联缺陷列表
tapd testx plan list-case-events --case-uid=<必填> [--data=<用于填充 body 字段>] [--limit] [--offset] --plan-uid=<必填>  # 计划下用例事件
tapd testx plan list-case-issues --case-uid=<必填> [--data=<用于填充 body 字段>] --issue-type=<必填> [--limit] [--offset] --plan-uid=<必填>  # 计划下用例关联缺陷
tapd testx plan list-cases [--data=<用于填充 body 字段>] --uid=<必填>  # 计划下用例列表
tapd testx plan list-history [--data=<用于填充 body 字段>] [--limit] [--offset] --plan-uid=<必填>  # 计划变更历史
tapd testx plan list-stories [--data=<用于填充 body 字段>] [--limit] [--offset] --plan-uid=<必填>  # 计划关联需求列表
tapd testx plan list-templates [--data=<用于填充 body 字段>] [--limit] [--offset]  # 计划模板列表
tapd testx plan statistics [--data=<用于填充 body 字段>]  # 计划统计信息
tapd testx plan unbind-bug --case-uid=<必填> [--data=<用于填充 body 字段>] --issue-uid=<必填> --plan-uid=<必填>  # 移除计划用例关联缺陷
tapd testx plan update [--data=<用于填充 body 字段>] --uid=<必填>  # 更新计划
tapd testx plan update-target-scope [--data=<用于填充 body 字段>] --uid=<必填>  # 更新计划范围目标
tapd testx report get --uid=<必填>  # 报告详情
tapd testx report get-data --report-uid=<必填> --template-uid=<必填>  # 报告详情数据
tapd testx report list [--creators=<逗号分隔>] [--end-at] [--limit] [--offset] [--plan-uids=<逗号分隔>] [--search] [--source] [--sources=<逗号分隔>] [--start-at] [--template-uid] [--with-associated]  # 报告列表
tapd testx report list-templates [--limit] [--offset]  # 报告模板列表
```

### timesheet — 花费工时管理

```bash
tapd timesheet count [--entity-id] [--entity-type=<story|task|bug>] [--owner]  # 查询花费工时数量
tapd timesheet delete --cost-ids=<多个以逗号分隔> --entity-id=<必需> --entity-type=<story|task|bug>  # 删除花费工时
```

### user — 用户信息管理

```bash
tapd user info  # 获取当前用户信息
tapd user views [--type=<目前只支持 story>]  # 获取用户视图列表
```

### wiki — Wiki 文档管理

```bash
tapd wiki count  # 查询 Wiki 文档数量
```

### workflow — 工作流状态管理

```bash
tapd workflow first-step --system=<story|bug> [--workitem-type-id]  # 获取工作流起始状态
tapd workflow list --system=<story|bug> [--workitem-type-id]  # 获取工作流列表
```

### workspace — 工作区管理

```bash
tapd workspace documents [--limit=<默认 30，最大 200>] [--page]  # 获取项目文档列表
tapd workspace members add --nick=<必需> [--role-ids=<逗号分隔>]  # 添加项目成员
tapd workspace roles  # 查看用户组 ID 对照关系
tapd workspace settings --type=<必需，如 is_enabled_story_category / workspace_metrology>  # 获取项目配置开关
tapd workspace sub-workspaces  # 获取子项目信息
tapd workspace users  # 查看项目成员列表
```


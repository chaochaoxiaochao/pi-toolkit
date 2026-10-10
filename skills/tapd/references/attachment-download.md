# 附件与图片

在下载 TAPD 附件或内嵌图片前完整执行本流程。`attachment download` 和 `image get` 返回带短期授权的 JSON 下载描述，不返回文件字节。

## 取得下载 URL

先通过 `attachment list` 记录附件 ID、文件名，以及响应实际提供的大小或校验信息。不要假设列表一定包含大小字段。

每次开始新的下载尝试前重新获取下载描述。将本文件中的 `<skill-dir>` 替换为当前 TAPD Skill 所在目录，使用随 Skill 发布且经过回归测试的解析器提取并校验 `download_url`：

```bash
URL="$(
  tapd attachment download --workspace-id="$WORKSPACE_ID" --id="$ATTACHMENT_ID" |
  node <skill-dir>/scripts/extract-download-url.mjs
)"
```

内嵌图片使用 `tapd image get --workspace-id="$WORKSPACE_ID" --image-path="$IMAGE_PATH"` 取得 JSON，再按同一规则读取 `download_url`。解析器只接受 HTTPS。不要输出或持久保存临时 URL。

## 安全下载

设置来自附件列表的目标文件名，并完整执行下载命令：

```bash
set -euo pipefail

OUTPUT='<附件文件名>'
PART="${OUTPUT}.part"
if [ -e "$OUTPUT" ] || [ -e "$PART" ]; then
  echo 'refusing to reuse an existing download path' >&2
  exit 1
fi
curl --fail --location --retry 3 \
  --proto '=https' --proto-redir '=https' \
  --output "$PART" -- "$URL"
test -s "$PART"
```

随后依次执行：

1. HTTP 失败时停止，不把错误正文写入最终文件。
2. 一次传输失败后，重新获取临时 URL。优先删除 `.part` 并从头下载，避免把过期 token 的响应或不匹配的文件片段拼进结果。
3. 下载后检查 `.part` 非空，并结合附件列表中的文件名、类型和已知 TAPD 错误特征排除 `token expire` 等错误响应。JSON 或 HTML 本身可能就是合法附件，不能只凭格式判为污染。
4. 响应若提供预期大小或校验和，必须匹配；未提供时明确不能完成该项校验，不得虚构预期大小。
5. 按格式做完整性检查：ZIP 使用 `unzip -t "$PART"`，图片使用环境可用的格式识别/解码能力，其他格式使用对应检查。
6. 全部检查通过后执行 `mv -- "$PART" "$OUTPUT"`。目标文件或 `.part` 已存在时必须在下载前失败，避免把旧文件误认为本次结果；任何检查失败都不得创建最终文件。

本流程不续传失败的 `.part`。附件大小未知或大于 50 MB 时，工具超时至少设为 600 秒；timeout 仅表示本地执行被终止。删除残留 `.part`，重新获取临时 URL 后从头下载；临时 URL 过期不能说明原附件损坏。

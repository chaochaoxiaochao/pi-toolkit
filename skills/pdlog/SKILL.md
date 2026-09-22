---
name: pdlog
description: 解压和查看 .pdlog 日志文件。触发：.pdlog 文件、普渡日志/Pudu 日志、日志打开是乱码或二进制、ppmd 解压
---

# pdlog

`.pdlog` 是普渡专有压缩日志格式：`cat`/`head`/编辑器直接打开是二进制乱码——这是格式本身，不是文件损坏。先解压成纯文本再读。

## 解压

使用本 skill 目录的 `tools/ppmd`：

```bash
tools/ppmd -d input.pdlog output.log
```

- 只想预览不落盘：`tools/ppmd -d input.pdlog /dev/stdout | head -50`
- 完成判据：`file output.log` 显示 text，`head` 能读到可读行。输出是二进制说明输入不是 pdlog，回到格式分叉。

## 格式分叉

- `.gz` 结尾：普通 gzip，用 `zcat`/`gunzip`，不经过 ppmd。
- 拿不准：先 `file` 看类型。

## 远端文件

pdlog 在远端设备或机器上时，先取回本地（`adb pull` / `scp`），解压始终在本地跑。
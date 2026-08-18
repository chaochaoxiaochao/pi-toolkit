#!/usr/bin/env bash
# Install pi-toolkit global pieces.
# 1) global AGENTS.md  -> ~/.pi/agent/AGENTS.md  (pi 启动时自动加载的全局指令)
#    pi 安装包另跑: pi install npm:@maxiaochao/pi-toolkit
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> global AGENTS.md -> ~/.pi/agent/AGENTS.md"
cp -f global/AGENTS.md "$HOME/.pi/agent/AGENTS.md"
echo "installed. run /reload (or restart pi) to load it."

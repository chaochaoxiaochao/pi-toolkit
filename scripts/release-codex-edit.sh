#!/usr/bin/env bash
set -euo pipefail
exec "$(cd "$(dirname "$0")" && pwd)/release-package.sh" codex-edit "${1:-patch}" "${2:-release}"

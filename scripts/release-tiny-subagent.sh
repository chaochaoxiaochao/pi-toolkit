#!/usr/bin/env bash
set -euo pipefail
exec "$(cd "$(dirname "$0")" && pwd)/release-package.sh" tiny-subagent "${1:-patch}" "${2:-release maintenance updates}"

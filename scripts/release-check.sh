#!/usr/bin/env bash
# The single release gate used both before tagging and in GitHub Actions.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SLUG="${1:-}"

cd "$ROOT_DIR"
if [[ -n "$SLUG" && ! -f "packages/$SLUG/package.json" ]]; then
  echo "unknown child package: $SLUG" >&2
  exit 1
fi

echo "==> release check: complete test suite"
npm test

echo "==> release check: extension load checks"
npm run load-test

if [[ -n "$SLUG" ]]; then
  echo "==> release check: child package contents: $SLUG"
  npm pack "./packages/$SLUG" --dry-run
fi

echo "==> release check: real Herdr child Agent smoke"
npm --prefix packages/herdr-subagents run test:real-herdr

echo "==> release check: root package contents"
npm pack --dry-run

#!/usr/bin/env bash
# Release @maxiaochao/pi-herdr-subagents: test -> version -> changelog -> commit -> tag -> push.
# Usage: ./scripts/release-herdr-subagents.sh [initial|patch|minor|major] [changelog note].
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
PACKAGE_DIR="$ROOT_DIR/packages/herdr-subagents"
LEVEL="${1:-patch}"
NOTE="${2:-release maintenance updates}"

cd "$ROOT_DIR"

echo "==> 1/6 package tests"
npm test --prefix "$PACKAGE_DIR"

echo "==> 2/6 extension load test"
pi -ne -ns --no-session -e ./packages/herdr-subagents/extensions/herdr-subagents.ts

echo "==> 3/6 version bump ($LEVEL)"
if [[ "$LEVEL" == "initial" ]]; then
  VERSION=$(node -p "require('./packages/herdr-subagents/package.json').version")
else
  npm --prefix "$PACKAGE_DIR" version "$LEVEL" --no-git-tag-version
  VERSION=$(node -p "require('./packages/herdr-subagents/package.json').version")
fi


echo "==> 4/6 package changelog"
TMP_CHANGELOG=$(mktemp)
{
  printf '## %s - v%s\n\n- %s\n\n' "$(date +%F)" "$VERSION" "$NOTE"
  cat "$PACKAGE_DIR/CHANGELOG.md"
} > "$TMP_CHANGELOG"
mv "$TMP_CHANGELOG" "$PACKAGE_DIR/CHANGELOG.md"


echo "==> 5/6 commit and tag"
git add packages/herdr-subagents
git commit -m "release herdr-subagents v${VERSION}"
git tag "herdr-subagents-v${VERSION}"

echo "==> 6/6 push commit and tag"
git push origin main
git push origin "herdr-subagents-v${VERSION}"

echo "tag herdr-subagents-v${VERSION} pushed; .github/workflows/publish-herdr-subagents.yml will publish it to npm"

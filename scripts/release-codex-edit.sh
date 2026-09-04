#!/usr/bin/env bash
# Release @maxiaochao/pi-codex-edit: test -> package check -> commit -> tag -> push.
# Usage: ./scripts/release-codex-edit.sh [initial|patch|minor|major] [changelog note].
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
PACKAGE_DIR="$ROOT_DIR/packages/codex-edit"
LEVEL="${1:-initial}"
NOTE="${2:-initial release}"

cd "$ROOT_DIR"

echo "==> 1/6 package tests"
(cd "$PACKAGE_DIR" && npm test)

echo "==> 2/6 package contents"
(cd "$PACKAGE_DIR" && npm pack --dry-run)

echo "==> 3/6 version bump ($LEVEL)"
if [[ "$LEVEL" == "initial" ]]; then
  VERSION=$(node -p "require('./packages/codex-edit/package.json').version")
else
  npm --prefix "$PACKAGE_DIR" version "$LEVEL" --no-git-tag-version
  VERSION=$(node -p "require('./packages/codex-edit/package.json').version")
fi

echo "==> 4/6 package changelog"
TMP_CHANGELOG=$(mktemp)
{
  printf '## %s - v%s\n\n- %s\n\n' "$(date +%F)" "$VERSION" "$NOTE"
  cat "$PACKAGE_DIR/CHANGELOG.md"
} > "$TMP_CHANGELOG"
mv "$TMP_CHANGELOG" "$PACKAGE_DIR/CHANGELOG.md"

echo "==> 5/6 commit and tag"
git add packages/codex-edit .github/workflows/publish-codex-edit.yml scripts/release-codex-edit.sh README.md AGENTS.md
git commit -m "release codex-edit v${VERSION}"
git tag "codex-edit-v${VERSION}"

echo "==> 6/6 push commit and tag"
git push origin main
git push origin "codex-edit-v${VERSION}"
echo "tag codex-edit-v${VERSION} pushed; .github/workflows/publish-codex-edit.yml will publish it to npm"

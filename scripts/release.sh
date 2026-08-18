#!/usr/bin/env bash
# Release script for pi-toolkit: test -> version -> changelog -> commit -> tag -> push -> CI publish.
# Usage: ./scripts/release.sh [patch|minor|major] [changelog note]   (default: patch)
set -euo pipefail
cd "$(dirname "$0")/.."

LEVEL="${1:-patch}"
NOTE="${2:-release maintenance updates}"

echo "==> 1/6 tests"
npm test || { echo "tests failed"; exit 1; }
echo "==> 2/6 load tests"
npm run load-test || { echo "load test failed"; exit 1; }

echo "==> 3/6 version bump ($LEVEL)"
npm version "$LEVEL" --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")

echo "==> 4/6 changelog"
TMP_CHANGELOG=$(mktemp)
{
  printf '## %s - v%s\n\n- %s\n\n' "$(date +%F)" "$VERSION" "$NOTE"
  [ ! -f CHANGELOG.md ] || cat CHANGELOG.md
} > "$TMP_CHANGELOG"
mv "$TMP_CHANGELOG" CHANGELOG.md

echo "==> 5/6 commit and tag"
git add -A
git commit -m "release v${VERSION}"
git tag "v${VERSION}"

echo "==> 6/6 push commit and tag"
git push origin main
git push origin "v${VERSION}"
echo "tag v${VERSION} pushed; .github/workflows/publish.yml will publish it to npm"

echo
echo "next: pi update npm:@maxiaochao/pi-toolkit  (or on other machines: pi install npm:@maxiaochao/pi-toolkit)"

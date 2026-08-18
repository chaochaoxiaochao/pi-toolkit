#!/usr/bin/env bash
# Release script for pi-toolkit: test -> version -> changelog -> tag -> push -> publish.
# Usage: ./scripts/release.sh [patch|minor|major]   (default: patch)
set -euo pipefail
cd "$(dirname "$0")/.."

LEVEL="${1:-patch}"

echo "==> 1/6 tests"
npm test || { echo "tests failed"; exit 1; }
echo "==> 2/6 load tests"
npm run load-test || { echo "load test failed"; exit 1; }

echo "==> 3/6 version bump ($LEVEL)"
npm version "$LEVEL" --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")

echo "==> 4/6 changelog"
CHANGELOG_ENTRY="## $(date +%F) - v${VERSION}\n\n- tbd\n"
if [ -f CHANGELOG.md ]; then
  sed -i "1i ${CHANGELOG_ENTRY}" CHANGELOG.md
else
  printf "# Changelog\n\n${CHANGELOG_ENTRY}" > CHANGELOG.md
fi

echo "==> 5/6 commit, tag, push"
git add -A
git commit -m "release v${VERSION}"
git tag "v${VERSION}"
git push origin main
git push origin "v${VERSION}"

echo "==> 6/6 publish"
npm publish
echo "published v${VERSION}"

echo
echo "next: pi update npm:pi-toolkit  (or on other machines: pi install npm:pi-toolkit)"
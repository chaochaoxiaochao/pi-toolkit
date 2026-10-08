#!/usr/bin/env bash
# Release one child and the root bundle from the same commit.
# Usage: ./scripts/release-package.sh <slug> <child-level> "note" [root-level]
# Levels: child = initial|patch|minor|major; root = patch|minor|major (default: patch).
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SLUG="${1:-}"
CHILD_LEVEL="${2:-patch}"
NOTE="${3:-release maintenance updates}"
ROOT_LEVEL="${4:-patch}"
PACKAGE_DIR="$ROOT_DIR/packages/$SLUG"

[[ -n "$SLUG" && -f "$PACKAGE_DIR/package.json" ]] || {
  echo "unknown child package: $SLUG" >&2
  exit 1
}
[[ "$CHILD_LEVEL" =~ ^(initial|patch|minor|major)$ ]] || {
  echo "child level must be initial, patch, minor, or major" >&2
  exit 1
}
[[ "$ROOT_LEVEL" =~ ^(patch|minor|major)$ ]] || {
  echo "root level must be patch, minor, or major" >&2
  exit 1
}

cd "$ROOT_DIR"
[[ "$(git branch --show-current)" == main ]] || {
  echo "coordinated releases must run on main" >&2
  exit 1
}
[[ -z "$(git status --porcelain)" ]] || {
  echo "working tree must be clean before a coordinated release" >&2
  exit 1
}

echo "==> 1/9 complete test suite"
npm test

echo "==> 2/9 extension load checks"
npm run load-test

echo "==> 3/9 child package contents: $SLUG"
npm pack "./packages/$SLUG" --dry-run

echo "==> 4/9 root package contents"
npm pack --dry-run

echo "==> 5/9 version bumps (child: $CHILD_LEVEL, root: $ROOT_LEVEL)"
if [[ "$CHILD_LEVEL" != initial ]]; then
  npm --prefix "$PACKAGE_DIR" version "$CHILD_LEVEL" --no-git-tag-version
fi
npm version "$ROOT_LEVEL" --no-git-tag-version
CHILD_VERSION=$(node -p "require('./packages/$SLUG/package.json').version")
ROOT_VERSION=$(node -p "require('./package.json').version")
CHILD_TAG="$SLUG-v$CHILD_VERSION"
ROOT_TAG="v$ROOT_VERSION"

git rev-parse --verify --quiet "refs/tags/$CHILD_TAG" >/dev/null && {
  echo "tag already exists: $CHILD_TAG" >&2
  exit 1
}
git rev-parse --verify --quiet "refs/tags/$ROOT_TAG" >/dev/null && {
  echo "tag already exists: $ROOT_TAG" >&2
  exit 1
}

echo "==> 6/9 child changelog"
node scripts/update-release-changelog.mjs "$PACKAGE_DIR/CHANGELOG.md" "$CHILD_VERSION" "$NOTE"

echo "==> 7/9 root changelog"
node scripts/update-release-changelog.mjs CHANGELOG.md "$ROOT_VERSION" "bundle $SLUG v$CHILD_VERSION: $NOTE"

echo "==> 8/9 one commit, two tags"
git add package.json CHANGELOG.md "$PACKAGE_DIR/package.json" "$PACKAGE_DIR/CHANGELOG.md"
git commit -m "release $SLUG v${CHILD_VERSION} and toolkit v${ROOT_VERSION}"
git tag "$CHILD_TAG"
git tag "$ROOT_TAG"

echo "==> 9/9 atomic push"
git push --atomic origin main "$CHILD_TAG" "$ROOT_TAG"
echo "$CHILD_TAG and $ROOT_TAG point to the same commit"
echo "publish-package.yml and publish.yml will publish both npm packages"

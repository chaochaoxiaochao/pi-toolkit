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

ROLLBACK_RELEASE_METADATA=1
rollback_release_metadata() {
  if [[ "$ROLLBACK_RELEASE_METADATA" == 1 ]]; then
    git restore -- package.json CHANGELOG.md "$PACKAGE_DIR/package.json" "$PACKAGE_DIR/CHANGELOG.md"
  fi
}
trap rollback_release_metadata ERR

echo "==> 1/6 version bumps (child: $CHILD_LEVEL, root: $ROOT_LEVEL)"
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

echo "==> 2/6 child changelog"
node scripts/update-release-changelog.mjs "$PACKAGE_DIR/CHANGELOG.md" "$CHILD_VERSION" "$NOTE"

echo "==> 3/6 root changelog"
node scripts/update-release-changelog.mjs CHANGELOG.md "$ROOT_VERSION" "bundle $SLUG v$CHILD_VERSION: $NOTE"

echo "==> 4/6 release checks against final package versions"
./scripts/release-check.sh "$SLUG"
while IFS= read -r line; do
  path=${line:3}
  case "$path" in
    package.json|CHANGELOG.md|"packages/$SLUG/package.json"|"packages/$SLUG/CHANGELOG.md") ;;
    *) echo "release checks changed unexpected file: $path" >&2; false ;;
  esac
done < <(git status --porcelain)
ROLLBACK_RELEASE_METADATA=0

echo "==> 5/6 one commit, two tags"
git add package.json CHANGELOG.md "$PACKAGE_DIR/package.json" "$PACKAGE_DIR/CHANGELOG.md"
git commit -m "release $SLUG v${CHILD_VERSION} and toolkit v${ROOT_VERSION}"
git tag "$CHILD_TAG"
git tag "$ROOT_TAG"

echo "==> 6/6 atomic push"
git push --atomic origin main "$CHILD_TAG" "$ROOT_TAG"
echo "$CHILD_TAG and $ROOT_TAG point to the same commit"
echo "publish.yml will verify once and publish both npm packages idempotently"

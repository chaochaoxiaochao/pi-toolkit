#!/usr/bin/env bash
# Release script for pi-toolkit: test -> version -> changelog -> commit -> tag -> push -> CI publish.
# Usage: ./scripts/release.sh [patch|minor|major] [changelog note]   (default: patch)
set -euo pipefail
cd "$(dirname "$0")/.."

LEVEL="${1:-patch}"
NOTE="${2:-release maintenance updates}"

[[ "$(git branch --show-current)" == main ]] || {
  echo "releases must run on main" >&2
  exit 1
}
[[ -z "$(git status --porcelain)" ]] || {
  echo "working tree must be clean before a release" >&2
  exit 1
}

ROLLBACK_RELEASE_METADATA=1
rollback_release_metadata() {
  if [[ "$ROLLBACK_RELEASE_METADATA" == 1 ]]; then
    git restore -- package.json CHANGELOG.md
  fi
}
trap rollback_release_metadata ERR

echo "==> 1/5 version bump ($LEVEL)"
npm version "$LEVEL" --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")

echo "==> 2/5 changelog"
TMP_CHANGELOG=$(mktemp)
{
  printf '## %s - v%s\n\n- %s\n\n' "$(date +%F)" "$VERSION" "$NOTE"
  [ ! -f CHANGELOG.md ] || cat CHANGELOG.md
} > "$TMP_CHANGELOG"
mv "$TMP_CHANGELOG" CHANGELOG.md

echo "==> 3/5 release checks against final package version"
./scripts/release-check.sh
while IFS= read -r line; do
  path=${line:3}
  case "$path" in
    package.json|CHANGELOG.md) ;;
    *) echo "release checks changed unexpected file: $path" >&2; false ;;
  esac
done < <(git status --porcelain)
ROLLBACK_RELEASE_METADATA=0

echo "==> 4/5 commit and tag"
git add package.json CHANGELOG.md
git commit -m "release v${VERSION}"
git tag "v${VERSION}"

echo "==> 5/5 atomic push"
git push --atomic origin main "v${VERSION}"
echo "tag v${VERSION} pushed; .github/workflows/publish.yml will publish it to npm"

echo
echo "next: pi update npm:@maxiaochao/pi-toolkit  (or on other machines: pi install npm:@maxiaochao/pi-toolkit)"

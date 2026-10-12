#!/usr/bin/env bash
# Publish one package directory, or succeed when that exact version already exists.
set -euo pipefail

PACKAGE_DIR="${1:-.}"
NAME=$(node -p "require('./$PACKAGE_DIR/package.json').name")
VERSION=$(node -p "require('./$PACKAGE_DIR/package.json').version")

if PUBLISHED_VERSION=$(npm view "$NAME@$VERSION" version 2>/dev/null) && [[ "$PUBLISHED_VERSION" == "$VERSION" ]]; then
  echo "$NAME@$VERSION already exists; skipping publish"
  exit 0
fi

echo "publishing $NAME@$VERSION"
(cd "$PACKAGE_DIR" && npm publish)

#!/usr/bin/env bash
# The final-content release gate. Child releases validate only their package plus
# shared package layout and the root tarball; root-only releases validate the suite.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SLUG="${1:-}"

cd "$ROOT_DIR"
if [[ -n "$SLUG" && ! -f "packages/$SLUG/package.json" ]]; then
  echo "unknown child package: $SLUG" >&2
  exit 1
fi

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ "${RELEASE_CHECK_DRY_RUN:-0}" != 1 ]]; then
    "$@"
  fi
}

has_package_script() {
  node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(p.scripts?.[process.argv[2]] ? 0 : 1)' "$1/package.json" "$2"
}

if [[ -n "$SLUG" ]]; then
  PACKAGE_DIR="packages/$SLUG"

  echo "==> release check: shared package layout"
  run node tests/package-layout.mjs

  echo "==> release check: target package tests: $SLUG"
  run npm --prefix "$PACKAGE_DIR" test

  if has_package_script "$PACKAGE_DIR" load-test; then
    echo "==> release check: target package load checks: $SLUG"
    run npm --prefix "$PACKAGE_DIR" run load-test
  fi

  echo "==> release check: child package contents: $SLUG"
  run npm pack "./$PACKAGE_DIR" --dry-run
else
  echo "==> release check: root-owned tests"
  run npm run test:root

  echo "==> release check: root-owned extension load checks"
  run npm run load-test:root
fi

RUN_REAL_HERDR=0
if [[ "$SLUG" == herdr-subagents ]]; then
  RUN_REAL_HERDR=1
else
  BASE_TAG="${RELEASE_CHECK_BASE_TAG:-$(git describe --tags --match 'v[0-9]*' --abbrev=0 HEAD 2>/dev/null || true)}"
  if [[ -z "$BASE_TAG" ]] || ! git diff --quiet "$BASE_TAG" -- packages/herdr-subagents; then
    RUN_REAL_HERDR=1
  fi
fi

if [[ "$RUN_REAL_HERDR" == 1 ]]; then
  echo "==> release check: real Herdr child Agent smoke"
  run npm --prefix packages/herdr-subagents run test:real-herdr
else
  echo "==> release check: real Herdr child Agent smoke skipped (Herdr is unchanged)"
fi

echo "==> release check: root package contents"
run npm pack --dry-run

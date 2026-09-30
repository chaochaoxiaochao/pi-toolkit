#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/pi" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$PWD" > "${PI_WORKTREE_TEST_OUTPUT}.cwd"
printf '%s\n' "$@" > "${PI_WORKTREE_TEST_OUTPUT}.args"
EOF
chmod +x "$ROOT/bin/pi"

mkdir "$ROOT/repo"
cd "$ROOT/repo"
git init -q -b main
git config user.email test@example.com
git config user.name Test
printf '.worktrees/\n' > .gitignore
printf 'base\n' > tracked.txt
git add .gitignore tracked.txt
git commit -qm initial

export PATH="$ROOT/bin:$PATH"
export PI_WORKTREE_TEST_OUTPUT="$ROOT/pi"
bash "$PACKAGE_DIR/bin/pi-worktree" start feature --model fake/model

test -d .worktrees/feature
test "$(git -C .worktrees/feature branch --show-current)" = feature
test "$(cat "$ROOT/pi.cwd")" = "$ROOT/repo/.worktrees/feature"
grep -qx -- '--model' "$ROOT/pi.args"
grep -qx -- 'fake/model' "$ROOT/pi.args"

bash "$PACKAGE_DIR/bin/pi-worktree" list > "$ROOT/list.txt"
grep -q 'main checkout' "$ROOT/list.txt"
grep -q 'feature' "$ROOT/list.txt"

bash "$PACKAGE_DIR/bin/pi-worktree" info feature > "$ROOT/info.txt"
grep -q 'status:   clean' "$ROOT/info.txt"
grep -q 'branch:   feature' "$ROOT/info.txt"
grep -q 'based on:' "$ROOT/info.txt"

bash "$PACKAGE_DIR/bin/pi-worktree" --help | grep -q 'pi-worktree start'
printf 'PASS worktree CLI integration cases\n'

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

bash "$PACKAGE_DIR/bin/pi-worktree" prepare --json feature > "$ROOT/reused.json"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "reused" || value.branch !== "feature" || value.dirty !== false) process.exit(1);
' "$ROOT/reused.json"

bash "$PACKAGE_DIR/bin/pi-worktree" prepare --json prepared > "$ROOT/created.json"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "created" || value.branch !== "prepared" || !value.path.endsWith("/.worktrees/prepared")) process.exit(1);
' "$ROOT/created.json"

mkdir -p nested/path
(cd nested/path && bash "$PACKAGE_DIR/bin/pi-worktree" prepare --json from-subdir) > "$ROOT/subdir.json"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.path !== process.argv[2] + "/.worktrees/from-subdir") process.exit(1);
' "$ROOT/subdir.json" "$ROOT/repo"

git branch attachable
bash "$PACKAGE_DIR/bin/pi-worktree" prepare --json attachable > "$ROOT/attached.json"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "attached" || value.branch !== "attachable") process.exit(1);
' "$ROOT/attached.json"

bash "$PACKAGE_DIR/bin/pi-worktree" prepare --json stale > /dev/null
rm -rf .worktrees/stale
if bash "$PACKAGE_DIR/bin/pi-worktree" prepare --json stale >/dev/null 2>&1; then
  echo "prepare silently replaced a stale worktree registration" >&2
  exit 1
fi
git worktree prune

git worktree add .worktrees/wrong -b another-branch >/dev/null
if bash "$PACKAGE_DIR/bin/pi-worktree" prepare --json wrong >/dev/null 2>&1; then
  echo "prepare reused a path checked out on the wrong branch" >&2
  exit 1
fi

mkdir .worktrees/main
if bash "$PACKAGE_DIR/bin/pi-worktree" prepare --json main >/dev/null 2>&1; then
  echo "prepare reused an ordinary directory as a worktree"
  exit 1
fi

printf 'changed\n' >> .worktrees/prepared/tracked.txt
bash "$PACKAGE_DIR/bin/pi-worktree" prepare --json prepared > "$ROOT/dirty.json"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "reused" || value.dirty !== true) process.exit(1);
' "$ROOT/dirty.json"

(cd .worktrees/prepared && bash "$PACKAGE_DIR/bin/pi-worktree" prepare --json prepared) > "$ROOT/active.json"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "already-active" || value.dirty !== true) process.exit(1);
' "$ROOT/active.json"

if bash "$PACKAGE_DIR/bin/pi-worktree" prepare --json ../escape >/dev/null 2>&1; then
  echo "prepare accepted an unsafe worktree name" >&2
  exit 1
fi

mkdir "$ROOT/symlink-repo" "$ROOT/outside-worktrees"
(
  cd "$ROOT/symlink-repo"
  git init -q -b main
  git config user.email test@example.com
  git config user.name Test
  printf 'base\n' > tracked.txt
  git add tracked.txt
  git commit -qm initial
  ln -s "$ROOT/outside-worktrees" .worktrees
  if bash "$PACKAGE_DIR/bin/pi-worktree" prepare --json escaped >/dev/null 2>&1; then
    echo "prepare followed a symlinked .worktrees directory" >&2
    exit 1
  fi
)

bash "$PACKAGE_DIR/bin/pi-worktree" --help | grep -q 'pi-worktree start'
printf 'PASS worktree CLI integration cases\n'

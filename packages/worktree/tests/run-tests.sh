#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT

mkdir "$ROOT/repo"
cd "$ROOT/repo"
git init -q -b main
git config user.email test@example.com
git config user.name Test
printf '.worktrees/\n' > .gitignore
printf 'base\n' > tracked.txt
git add .gitignore tracked.txt
git commit -qm initial

feature_json=$(bash "$PACKAGE_DIR/bin/pi-worktree" create --json feature)

test -d .worktrees/feature
test "$(git -C .worktrees/feature branch --show-current)" = feature
node -e 'if (JSON.parse(process.argv[1]).status !== "created") process.exit(1)' "$feature_json"

bash "$PACKAGE_DIR/bin/pi-worktree" list > "$ROOT/list.txt"
grep -q 'main checkout' "$ROOT/list.txt"
grep -q 'feature' "$ROOT/list.txt"

bash "$PACKAGE_DIR/bin/pi-worktree" info feature > "$ROOT/info.txt"
grep -q 'status:   clean' "$ROOT/info.txt"
grep -q 'branch:   feature' "$ROOT/info.txt"
grep -q 'based on:' "$ROOT/info.txt"

bash "$PACKAGE_DIR/bin/pi-worktree" create --json feature > "$ROOT/reused.json"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "reused" || value.branch !== "feature" || value.dirty !== false) process.exit(1);
' "$ROOT/reused.json"

bash "$PACKAGE_DIR/bin/pi-worktree" create --json prepared > "$ROOT/created.json"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "created" || value.branch !== "prepared" || !value.path.endsWith("/.worktrees/prepared")) process.exit(1);
' "$ROOT/created.json"

mkdir -p nested/path
(cd nested/path && bash "$PACKAGE_DIR/bin/pi-worktree" create --json from-subdir) > "$ROOT/subdir.json"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.path !== process.argv[2] + "/.worktrees/from-subdir") process.exit(1);
' "$ROOT/subdir.json" "$ROOT/repo"

git branch attachable
bash "$PACKAGE_DIR/bin/pi-worktree" create --json attachable > "$ROOT/attached.json"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "attached" || value.branch !== "attachable") process.exit(1);
' "$ROOT/attached.json"

bash "$PACKAGE_DIR/bin/pi-worktree" create --json stale > /dev/null
rm -rf .worktrees/stale
if bash "$PACKAGE_DIR/bin/pi-worktree" create --json stale >/dev/null 2>&1; then
  echo "create silently replaced a stale worktree registration" >&2
  exit 1
fi
git worktree prune

git worktree add .worktrees/wrong -b another-branch >/dev/null
if bash "$PACKAGE_DIR/bin/pi-worktree" create --json wrong >/dev/null 2>&1; then
  echo "create reused a path checked out on the wrong branch" >&2
  exit 1
fi

mkdir .worktrees/main
if bash "$PACKAGE_DIR/bin/pi-worktree" create --json main >/dev/null 2>&1; then
  echo "create reused an ordinary directory as a worktree"
  exit 1
fi

printf 'changed\n' >> .worktrees/prepared/tracked.txt
bash "$PACKAGE_DIR/bin/pi-worktree" create --json prepared > "$ROOT/dirty.json"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "reused" || value.dirty !== true) process.exit(1);
' "$ROOT/dirty.json"

(cd .worktrees/prepared && bash "$PACKAGE_DIR/bin/pi-worktree" create --json prepared) > "$ROOT/active.json"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "already-active" || value.dirty !== true) process.exit(1);
' "$ROOT/active.json"

mkdir -p .worktrees/prepared/nested/path
(cd .worktrees/prepared/nested/path && bash "$PACKAGE_DIR/bin/pi-worktree" create --json prepared) > "$ROOT/active-subdir.json"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "already-active" || value.path !== process.argv[2] || value.dirty !== true) {
    throw new Error("already-active must return the worktree root even when called from a subdirectory");
  }
' "$ROOT/active-subdir.json" "$ROOT/repo/.worktrees/prepared"

if bash "$PACKAGE_DIR/bin/pi-worktree" create --json ../escape >/dev/null 2>&1; then
  echo "create accepted an unsafe worktree name" >&2
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
  if bash "$PACKAGE_DIR/bin/pi-worktree" create --json escaped >/dev/null 2>&1; then
    echo "create followed a symlinked .worktrees directory" >&2
    exit 1
  fi
)

bash "$PACKAGE_DIR/bin/pi-worktree" --help | grep -q 'pi-worktree create'
bash "$PACKAGE_DIR/bin/pi-worktree" remove feature attachable
test ! -d .worktrees/feature && test ! -d .worktrees/attachable
! git show-ref --verify --quiet refs/heads/feature
! git show-ref --verify --quiet refs/heads/attachable

bash "$PACKAGE_DIR/bin/pi-worktree" create --json batch-dirty >/dev/null
bash "$PACKAGE_DIR/bin/pi-worktree" create --json batch-later >/dev/null
echo dirty >> .worktrees/batch-dirty/tracked.txt
if printf 'n\n' | bash "$PACKAGE_DIR/bin/pi-worktree" rm batch-dirty batch-later; then
  echo "remove ignored a declined confirmation" >&2
  exit 1
fi
test -d .worktrees/batch-dirty && test -d .worktrees/batch-later
printf 'y\n' | bash "$PACKAGE_DIR/bin/pi-worktree" -r batch-dirty batch-later
test ! -d .worktrees/batch-dirty && test ! -d .worktrees/batch-later

bash "$PACKAGE_DIR/bin/pi-worktree" create --json batch-first >/dev/null
bash "$PACKAGE_DIR/bin/pi-worktree" create --json batch-last >/dev/null
if bash "$PACKAGE_DIR/bin/pi-worktree" --remove batch-first missing-name batch-last; then
  echo "remove ignored a missing worktree" >&2
  exit 1
fi
test ! -d .worktrees/batch-first && test -d .worktrees/batch-last
bash "$PACKAGE_DIR/bin/pi-worktree" create --json batch-unmerged >/dev/null
git -C .worktrees/batch-unmerged commit --allow-empty -qm unmerged
if printf 'n\n' | bash "$PACKAGE_DIR/bin/pi-worktree" remove batch-unmerged batch-last; then
  echo "remove ignored an unmerged branch confirmation" >&2
  exit 1
fi
test -d .worktrees/batch-unmerged && test -d .worktrees/batch-last
printf 'y\n' | bash "$PACKAGE_DIR/bin/pi-worktree" remove batch-unmerged batch-last
! git show-ref --verify --quiet refs/heads/batch-unmerged
test ! -d .worktrees/batch-last

if bash "$PACKAGE_DIR/bin/pi-worktree" remove >/dev/null 2>&1; then
  echo "remove accepted no names" >&2
  exit 1
fi
source "$PACKAGE_DIR/bin/pi-worktree-completion.bash"
COMP_WORDS=(pi-worktree remove prepared f)
COMP_CWORD=3
_pi_worktree
[[ " ${COMPREPLY[*]} " == *" from-subdir "* ]]
if bash "$PACKAGE_DIR/bin/pi-worktree" prepare feature >/dev/null 2>&1; then
  echo "removed prepare command is still accepted" >&2
  exit 1
fi
if bash "$PACKAGE_DIR/bin/pi-worktree" start feature >/dev/null 2>&1; then
  echo "removed start command is still accepted" >&2
  exit 1
fi
printf 'PASS worktree CLI integration cases\n'

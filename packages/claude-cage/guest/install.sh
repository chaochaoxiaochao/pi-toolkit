#!/usr/bin/env bash
set -euo pipefail
umask 077

revision=d5b5e04c314d3452d357174d16d10dda34daa2d2
parent="$HOME/.local/share"
destination="$parent/pi-claude-cage"
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_files=(pi-claude-cage.service pi-claude-cage.socket)
marker=.pi-claude-cage-install
node_path=$(node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error("Node >=22.19.0 is required");
  process.exit(1);
}
console.log(process.execPath);
')

# Reject dead user managers before touching a previous installation.
systemctl --user show-environment >/dev/null
mkdir -p "$parent" "$units"
work=$(mktemp -d "$parent/.pi-claude-cage.XXXXXX")
unit_stage=
cleanup() {
  if [ -n "$unit_stage" ]; then rm -f -- "$unit_stage"; fi
  if [ -d "$work/previous" ]; then
    printf 'Previous guest files retained at %s/previous\n' "$work" >&2
  else
    rm -rf -- "$work"
  fi
}
trap cleanup EXIT

exists() { [ -e "$1" ] || [ -L "$1" ]; }
regular() { [ -f "$1" ] && [ ! -L "$1" ]; }
refuse() {
  printf 'Refusing to replace unknown Claude Cage installation path: %s\n' "$1" >&2
  exit 1
}

check_targets() {
  if exists "$destination"; then
    [ -d "$destination" ] && [ ! -L "$destination" ] || refuse "$destination"
    regular "$destination/$marker" && cmp -s "$destination/$marker" "$stage/$marker" || refuse "$destination"
  fi

  local unit fragment
  for unit in "${unit_files[@]}"; do
    if exists "$units/$unit"; then
      regular "$units/$unit" && regular "$destination/$unit" &&
        cmp -s "$units/$unit" "$destination/$unit" || refuse "$units/$unit"
    fi
    fragment=$(systemctl --user show --property=FragmentPath --value "$unit")
    if [ -n "$fragment" ] && [ "$fragment" != "$units/$unit" ] && [ ! "$fragment" -ef "$units/$unit" ]; then
      refuse "$fragment"
    fi
  done
}

stage="$work/guest"
mkdir "$stage"
# The archive contains the trusted guest files at its root. Extract only
# regular file contents to explicit paths; do not restore archive metadata.
dd of="$work/guest.tar.gz" status=none
for file in client.mjs service.mjs protocol.mjs package.json package-lock.json "${unit_files[@]}"; do
  tar -xzOf "$work/guest.tar.gz" -- "$file" > "$stage/$file"
  test -s "$stage/$file"
done
printf 'pi-claude-cage guest installation v1\n' > "$stage/$marker"
printf '%s\n' "$revision" > "$work/REVISION"
check_targets

# Keep upstream TS outside node_modules: Node does not transform TS installed
# there. Keep the original src layout for the subprocess's inert-mcp.mjs path.
git init --quiet "$work/upstream"
git -C "$work/upstream" fetch --quiet --no-tags --depth=1 \
  https://github.com/earendil-works/pi-claude-code.git "$revision"
test "$(git -C "$work/upstream" rev-parse FETCH_HEAD)" = "$revision"
mkdir "$stage/upstream"
git -C "$work/upstream" archive "$revision" src LICENSE | tar -x -C "$stage/upstream"
cp -- "$work/REVISION" "$stage/upstream/REVISION"
(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
(cd "$stage" && "$node_path" --experimental-transform-types --input-type=module -e \
  'await import("./upstream/src/stream.ts"); await import("./upstream/src/claude-cli.ts");')
ln -s "$node_path" "$stage/node"

# Stop only these units, and only on reinstall. The socket owns activation.
check_targets
if [ -e "$destination" ]; then
  systemctl --user stop pi-claude-cage.socket pi-claude-cage.service
  mv -T -- "$destination" "$work/previous"
fi
mv -T --no-clobber -- "$stage" "$destination"
[ ! -d "$stage" ] || refuse "$destination"
for unit in "${unit_files[@]}"; do
  target="$units/$unit"
  unit_stage=$(mktemp "$units/.$unit.XXXXXX")
  install -m 0644 "$destination/$unit" "$unit_stage"
  if exists "$target"; then
    regular "$target" && regular "$work/previous/$unit" &&
      cmp -s "$target" "$work/previous/$unit" || refuse "$target"
    if ! cmp -s "$target" "$unit_stage"; then mv -fT -- "$unit_stage" "$target"; fi
  else
    # Publish complete contents without replacing a newly created unit.
    ln -T -- "$unit_stage" "$target" || refuse "$target"
  fi
  rm -f -- "$unit_stage"
  unit_stage=
done
systemctl --user daemon-reload
systemctl --user enable --now pi-claude-cage.socket
rm -rf -- "$work/previous"
printf 'Installed guest client: %s/client.mjs\n' "$destination"

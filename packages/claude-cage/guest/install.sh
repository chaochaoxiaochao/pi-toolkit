#!/usr/bin/env bash
set -euo pipefail
umask 077

revision=d5b5e04c314d3452d357174d16d10dda34daa2d2
parent="$HOME/.local/share"
destination="$parent/pi-claude-cage"
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
service_unit="$units/pi-claude-cage.service"
socket_unit="$units/pi-claude-cage.socket"
environment_file="${XDG_CONFIG_HOME:-$HOME/.config}/pi-claude-cage/environment"
marker=.pi-claude-cage-install
v1_marker='pi-claude-cage guest installation v1'
v2_marker='pi-claude-cage guest installation v2'
node_path=$(node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error("Node >=22.19.0 is required");
  process.exit(1);
}
console.log(process.execPath);
')

mkdir -p "$parent"
work=$(mktemp -d "$parent/.pi-claude-cage.XXXXXX")
cleanup() {
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

legacy=0
if exists "$destination"; then
  [ -d "$destination" ] && [ ! -L "$destination" ] || refuse "$destination"
  regular "$destination/$marker" || refuse "$destination"
  installed_marker=$(cat -- "$destination/$marker")
  case "$installed_marker" in
    "$v1_marker") legacy=1 ;;
    "$v2_marker")
      legacy=0
      for managed_path in "$service_unit" "$socket_unit" "$environment_file"; do
        exists "$managed_path" && refuse "$managed_path"
      done
      ;;
    *) refuse "$destination" ;;
  esac
else
  for managed_path in "$service_unit" "$socket_unit" "$environment_file"; do
    exists "$managed_path" && refuse "$managed_path"
  done
fi

stage="$work/guest"
mkdir "$stage"
dd of="$work/guest.tar.gz" status=none
for file in service.mjs protocol.mjs package.json package-lock.json; do
  tar -xzOf "$work/guest.tar.gz" -- "$file" > "$stage/$file"
  test -s "$stage/$file"
done
printf '%s\n' "$v2_marker" > "$stage/$marker"
printf '%s\n' "$revision" > "$work/REVISION"

# Keep the pinned upstream TypeScript outside node_modules so Node can transform it.
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

if [ "$legacy" = 1 ]; then
  # The exact marker owns this managed directory. Stop the old daemon before deleting its files.
  for managed_path in "$service_unit" "$socket_unit" "$environment_file"; do
    if exists "$managed_path"; then regular "$managed_path" || refuse "$managed_path"; fi
  done
  systemctl --user disable --now pi-claude-cage.socket
  systemctl --user stop pi-claude-cage.service
  rm -f -- "$service_unit" "$socket_unit" "$environment_file"
  systemctl --user daemon-reload
fi

if [ -e "$destination" ]; then mv -T -- "$destination" "$work/previous"; fi
mv -T --no-clobber -- "$stage" "$destination"
[ ! -d "$stage" ] || refuse "$destination"
rm -rf -- "$work/previous"
printf 'Installed guest service: %s/service.mjs\n' "$destination"

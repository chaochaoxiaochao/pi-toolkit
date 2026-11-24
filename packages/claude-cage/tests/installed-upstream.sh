#!/usr/bin/env bash
set -euo pipefail
umask 077

package=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
guest="$package/guest"
scratch=$(mktemp -d /tmp/claude-cage-install.XXXXXX)
trap 'rm -rf -- "$scratch"' EXIT
home="$scratch/home"
installed="$home/.local/share/pi-claude-cage"
mkdir -p "$home"

runner=(env -i "PATH=$PATH" "HOME=$home" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
  npm_config_update_notifier=false "npm_config_userconfig=$scratch/user.npmrc"
  "npm_config_globalconfig=$scratch/global.npmrc")
if [[ -n ${PI_CLAUDE_CAGE_TEST_UPSTREAM_REPO:-} || -n ${PI_CLAUDE_CAGE_TEST_NPM_CACHE:-} ]]; then
  repo=$(realpath -- "${PI_CLAUDE_CAGE_TEST_UPSTREAM_REPO:?Set an upstream Git repo for offline installation}")
  cache=$(realpath -- "${PI_CLAUDE_CAGE_TEST_NPM_CACHE:?Set a populated npm cache for offline installation}")
  mkdir "$scratch/npm-cache"
  cp -a -- "$cache/_cacache" "$scratch/npm-cache/"
  runner+=(GIT_ALLOW_PROTOCOL=file GIT_CONFIG_COUNT=1 "GIT_CONFIG_KEY_0=url.file://$repo.insteadOf"
    GIT_CONFIG_VALUE_0=https://github.com/earendil-works/pi-claude-code.git
    "npm_config_cache=$scratch/npm-cache" npm_config_offline=true)
fi

archive="$scratch/guest.tar.gz"
tar -C "$guest" -czf "$archive" service.mjs protocol.mjs package.json package-lock.json
install_guest() { "${runner[@]}" bash "$guest/install.sh" < "$archive"; }

install_guest
cmp "$guest/service.mjs" "$installed/service.mjs"
cmp "$guest/protocol.mjs" "$installed/protocol.mjs"
[[ $(<"$installed/.pi-claude-cage-install") == 'pi-claude-cage guest installation v2' ]]
[[ ! -e "$installed/client.mjs" ]]
[[ ! -e "$home/.config/systemd/user/pi-claude-cage.service" ]]

# Reinstallation replaces only the marker-owned v2 directory and starts no daemon.
install_guest
cmp "$guest/service.mjs" "$installed/service.mjs"

"${runner[@]}" PI_CLAUDE_CAGE_TEST_INSTALL_DIR="$installed" PI_CLAUDE_CAGE_TEST_HOME="$home" \
  node --test "$guest/installed-upstream.test.mjs"

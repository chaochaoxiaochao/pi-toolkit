#!/usr/bin/env bash
set -euo pipefail
umask 077

package=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
guest="$package/guest"
command -v systemd-socket-activate >/dev/null || {
  printf 'The installed guest test requires systemd-socket-activate.\n' >&2
  exit 1
}
scratch=$(mktemp -d /tmp/claude-cage-install.XXXXXX)
trap 'rm -rf -- "$scratch"' EXIT
home="$scratch/home"
units="$home/.config/systemd/user"
installed="$home/.local/share/pi-claude-cage"
log="$scratch/systemctl.log"
mkdir -p "$scratch/bin" "$scratch/runtime" "$units" "$(dirname -- "$installed")"

# No real user manager or shell/credential configuration enters the installer.
runner=(env -i "PATH=$scratch/bin:$PATH" "HOME=$home" "XDG_CONFIG_HOME=$home/.config"
  "XDG_RUNTIME_DIR=$scratch/runtime" "SYSTEMCTL_LOG=$log" GIT_CONFIG_NOSYSTEM=1
  GIT_TERMINAL_PROMPT=0 npm_config_update_notifier=false
  "npm_config_userconfig=$scratch/user.npmrc" "npm_config_globalconfig=$scratch/global.npmrc")
if [[ -n ${PI_CLAUDE_CAGE_TEST_UPSTREAM_REPO:-} || -n ${PI_CLAUDE_CAGE_TEST_NPM_CACHE:-} ]]; then
  repo=$(realpath -- "${PI_CLAUDE_CAGE_TEST_UPSTREAM_REPO:?Set an upstream Git repo for offline installation}")
  cache=$(realpath -- "${PI_CLAUDE_CAGE_TEST_NPM_CACHE:?Set a populated npm cache for offline installation}")
  mkdir "$scratch/npm-cache"
  cp -a -- "$cache/_cacache" "$scratch/npm-cache/"
  runner+=(GIT_ALLOW_PROTOCOL=file GIT_CONFIG_COUNT=1 "GIT_CONFIG_KEY_0=url.file://$repo.insteadOf"
    GIT_CONFIG_VALUE_0=https://github.com/earendil-works/pi-claude-code.git
    "npm_config_cache=$scratch/npm-cache" npm_config_offline=true)
fi

cat > "$scratch/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
case "$*" in
  '--user show-environment'|'--user stop pi-claude-cage.socket pi-claude-cage.service'|\
  '--user daemon-reload'|'--user enable --now pi-claude-cage.socket'|\
  '--user show --property=FragmentPath --value pi-claude-cage.socket') exit 0 ;;
  '--user show --property=FragmentPath --value pi-claude-cage.service')
    foreign="$HOME/foreign/pi-claude-cage.service"
    if [[ -e $foreign ]]; then printf '%s\n' "$foreign"; fi
    exit 0 ;;
esac
printf 'Unexpected systemctl arguments: %s\n' "$*" >&2
exit 1
STUB
chmod 0700 "$scratch/bin/systemctl"
archive="$scratch/guest.tar.gz"
tar -C "$guest" -czf "$archive" client.mjs service.mjs protocol.mjs package.json package-lock.json \
  pi-claude-cage.service pi-claude-cage.socket
cd -- "$scratch"
install_guest() { "${runner[@]}" bash "$guest/install.sh" < "$archive"; }
installer_actions() { grep -vF -- '--user show --property=FragmentPath --value' "$log"; }
expect_refusal() {
  : > "$log"
  if install_guest > "$scratch/install.out" 2>&1; then
    printf 'Installer did not refuse %s\n' "$1" >&2
    exit 1
  fi
  grep -Fq -- "Refusing to replace unknown Claude Cage installation path: $1" "$scratch/install.out"
  [[ $(installer_actions) == '--user show-environment' ]]
}

mkdir "$installed"
printf 'foreign directory\n' > "$installed/sentinel"
expect_refusal "$installed"
[[ $(<"$installed/sentinel") == 'foreign directory' ]]
rm -r -- "$installed"
ln -s -- "$scratch/missing" "$installed"
expect_refusal "$installed"
[[ -L $installed ]]
rm -- "$installed"

unit="$units/pi-claude-cage.service"
printf 'foreign unit\n' > "$unit"
expect_refusal "$unit"
[[ $(<"$unit") == 'foreign unit' && ! -e $installed ]]
rm -- "$unit"
ln -s -- "$scratch/missing" "$unit"
expect_refusal "$unit"
[[ -L $unit && ! -e $installed ]]
rm -- "$unit"
foreign="$home/foreign/pi-claude-cage.service"
mkdir -- "$(dirname -- "$foreign")"
printf 'foreign fragment\n' > "$foreign"
expect_refusal "$foreign"
[[ $(<"$foreign") == 'foreign fragment' && ! -e $installed && ! -e $unit ]]
rm -- "$foreign"

: > "$log"
install_guest
diff -u - <(installer_actions) <<'EXPECTED'
--user show-environment
--user daemon-reload
--user enable --now pi-claude-cage.socket
EXPECTED
cmp "$guest/service.mjs" "$installed/service.mjs"
printf '\n# local changes\n' >> "$unit"
expect_refusal "$unit"
grep -qF 'local changes' "$unit"
cmp "$guest/service.mjs" "$installed/service.mjs"
cp -- "$guest/pi-claude-cage.service" "$unit"

: > "$log"
install_guest
diff -u - <(installer_actions) <<'EXPECTED'
--user show-environment
--user stop pi-claude-cage.socket pi-claude-cage.service
--user daemon-reload
--user enable --now pi-claude-cage.socket
EXPECTED
cmp "$guest/pi-claude-cage.service" "$unit"
cmp "$guest/pi-claude-cage.socket" "$units/pi-claude-cage.socket"
rm -- "$installed/.pi-claude-cage-install"
expect_refusal "$installed"

"${runner[@]}" "PI_CLAUDE_CAGE_TEST_INSTALL_DIR=$installed" node --test "$guest/guest.test.mjs"

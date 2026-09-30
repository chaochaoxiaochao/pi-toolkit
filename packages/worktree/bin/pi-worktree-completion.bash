# bash completion for pi-worktree
_pi_worktree() {
  local cur first
  cur="${COMP_WORDS[COMP_CWORD]}"
  first="${COMP_WORDS[1]}"

  local SUBS="start list ls info out remove rm prune -l --list -i --info -o --out -r --remove -p --prune -h --help"

  # existing worktree names (only linked worktrees, i.e. under .worktrees/)
  local wts=""
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local main_dir
    main_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/.git$||')
    wts=$(git worktree list --porcelain 2>/dev/null \
      | sed -n 's|^worktree ||p' \
      | while read -r p; do [[ "$p" != "$main_dir" ]] && basename "$p"; done || true)
  fi

  if (( COMP_CWORD == 1 )); then
    # first word: subcommands, flags, and existing worktree names (to enter)
    COMPREPLY=($(compgen -W "$SUBS $wts" -- "$cur"))
    return
  fi

  case "$first" in
    -i|--info|info|-r|--remove|remove|rm|start)
      # only the second word of info/remove completes worktree names;
      # later words offer nothing (info/remove take no further args)
      if (( COMP_CWORD == 2 )); then
        COMPREPLY=($(compgen -W "$wts" -- "$cur"))
      else
        COMPREPLY=()
      fi
      ;;
    *)
      # after a name: default (file) completion for pi args
      COMPREPLY=()
      ;;
  esac
}
complete -F _pi_worktree pi-worktree

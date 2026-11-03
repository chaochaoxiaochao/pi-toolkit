# bash completion for pi-worktree
_pi_worktree() {
  local cur first
  cur="${COMP_WORDS[COMP_CWORD]}"
  first="${COMP_WORDS[1]}"

  local SUBS="create list ls info out remove rm prune -l --list -i --info -o --out -r --remove -p --prune -h --help"

  # Checked-out branch names also identify external worktrees and slash names.
  local wts=""
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local main_dir main_branch
    main_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/.git$||')
    main_branch=$(git -C "$main_dir" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
    wts=$(git for-each-ref --format='%(if)%(worktreepath)%(then)%(refname:strip=2)%(end)' refs/heads 2>/dev/null \
      | grep -vxF -- "$main_branch" || true)
  fi

  if (( COMP_CWORD == 1 )); then
    # first word: subcommands, flags, and existing worktree names
    COMPREPLY=($(compgen -W "$SUBS $wts" -- "$cur"))
    return
  fi

  case "$first" in
    -r|--remove|remove|rm)
      COMPREPLY=($(compgen -W "--force -f $wts" -- "$cur"))
      ;;
    -i|--info|info|create)
      # info and create accept one name
      if (( COMP_CWORD == 2 )); then
        COMPREPLY=($(compgen -W "$wts" -- "$cur"))
      else
        COMPREPLY=()
      fi
      ;;
    *)
      # no command-specific completion
      COMPREPLY=()
      ;;
  esac
}
complete -F _pi_worktree pi-worktree

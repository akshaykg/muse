#!/bin/bash
# VibeForge: commit + push after each change.
#
# Usage:
#   scripts/auto-commit-push.sh              # watch forever (polls every 3s)
#   scripts/auto-commit-push.sh --once       # one commit+push if changed, then exit
#   scripts/auto-commit-push.sh --dry-run    # show what would be committed, change nothing
#
# How it works: polls `git status`, waits for 5 quiet seconds after the last
# change (debounce, so it never commits half-typed files), commits everything
# .gitignore allows, and pushes. The push itself is done by the post-commit
# hook in .githooks/ (activated below), so manual commits push too.
# Stop with Ctrl-C. It never amends, never force-pushes, and skips while a
# git operation (merge/rebase/commit) is already running.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
git config core.hooksPath .githooks

DRY_RUN=0
ONCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --once) ONCE=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

commit_if_changed() {
  [ -e .git/index.lock ] && return 0                      # another git op running
  git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ] && return 0

  if [ "$DRY_RUN" = 1 ]; then
    echo "would commit:"
    git status --short
    return 0
  fi

  git add -A || return 0
  git diff --cached --quiet && return 0
  msg="auto: $(date '+%Y-%m-%d %H:%M:%S') $(git diff --cached --name-only | head -n 3 | tr '\n' ' ')"
  if git commit -q -m "$msg"; then
    echo "committed: $msg"   # post-commit hook pushes
  else
    echo "auto-commit: commit failed, will retry next change" >&2
  fi
}

if [ "$ONCE" = 1 ] || [ "$DRY_RUN" = 1 ]; then
  commit_if_changed
  exit 0
fi

echo "auto-commit-push: watching (Ctrl-C to stop)…"
last_hash=""
quiet_since=0
while true; do
  current=$( { git status --porcelain; git diff | head -c 2000; } | shasum | cut -d' ' -f1)
  if [ "$current" != "$last_hash" ]; then
    last_hash="$current"
    quiet_since=0
  else
    quiet_since=$((quiet_since + 3))
    if [ "$quiet_since" -ge 5 ]; then
      commit_if_changed
      last_hash=$( { git status --porcelain; git diff | head -c 2000; } | shasum | cut -d' ' -f1)
      quiet_since=0
    fi
  fi
  sleep 3
done

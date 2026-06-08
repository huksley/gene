#!/usr/bin/env bash
#
# Quick local checkout of a PR-in-progress to spin up the dev server against it.
#
# Usage:
#   npm run pipeline:test -- <PR#>           # recommended — resolves the branch via `gh pr view`,
#                                            # auto-detects the worktree, falls back to gh pr checkout
#   npm run pipeline:test -- <shortLink>     # use the agent's worktree directly
#                                            # at .ai-pipeline/worktrees/<shortLink>
#
# Examples:
#   npm run pipeline:test -- 42
#   npm run pipeline:test -- hfCEqC4v
#
# Notes:
# - Stops on first error. If `npm run dev` ports are already bound by another
#   process, kill that first.
# - Env files (`.env*`) are symlinked from main (they rarely change per-PR).
# - `node_modules/` and `data/` are CLONED from main via APFS copy-on-write
#   (`cp -cR` on macOS) so the worktree is fully isolated: migrations and
#   prisma generate don't touch main's DB or Prisma client. Falls back to
#   plain recursive copy on non-Darwin systems.

set -e

arg="${1:-}"
if [[ -z "$arg" ]]; then
  echo "Usage: npm run pipeline:test -- <shortLink|PR#>" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"

clone_dir() {
  local src="$1"
  local dst="$2"
  local label="$3"
  if [[ "$(uname)" == "Darwin" ]]; then
    echo "→ cloning $label from main (APFS copy-on-write — instant)"
    cp -cR "$src" "$dst"
  else
    echo "→ copying $label from main (slower, no copy-on-write)"
    cp -R "$src" "$dst"
  fi
}

if [[ "$arg" =~ ^[0-9]+$ ]]; then
  cd "$repo_root"
  pr_branch="$(gh pr view "$arg" --json headRefName -q .headRefName)"
  if [[ -z "$pr_branch" ]]; then
    echo "Could not resolve branch for PR #$arg" >&2
    exit 1
  fi

  existing_worktree="$(git worktree list --porcelain | awk -v b="refs/heads/$pr_branch" '
    /^worktree / { wt = substr($0, 10) }
    /^branch / && $2 == b { print wt; exit }
  ')"

  if [[ -n "$existing_worktree" ]]; then
    echo "→ PR #$arg (branch $pr_branch) already checked out at: $existing_worktree"
    cd "$existing_worktree"
    for env_file in ".env" ".env.local" ".env.development" ".env.test" ".env.production"; do
      if [[ ! -e "$env_file" && -f "$repo_root/$env_file" ]]; then
        echo "→ symlinking $env_file from main checkout"
        ln -s "$repo_root/$env_file" "$env_file"
      fi
    done
    for shared in "node_modules" "data"; do
      if [[ -L "$shared" ]]; then
        echo "→ removing stale $shared symlink (will be replaced with an isolated clone)"
        rm "$shared"
      fi
    done
    if [[ ! -e "node_modules" && -d "$repo_root/node_modules" ]]; then
      clone_dir "$repo_root/node_modules" "node_modules" "node_modules/"
    fi
    if [[ ! -e "data" && -d "$repo_root/data" ]]; then
      clone_dir "$repo_root/data" "data" "data/ (postgres / minio / redis state)"
    fi
    echo "→ npm run dev in $existing_worktree"
    exec npm run dev
  fi

  echo "→ gh pr checkout $arg"
  gh pr checkout "$arg"
  echo "→ npm run dev (in main checkout, on the PR branch)"
  exec npm run dev
fi

worktree="$repo_root/.ai-pipeline/worktrees/$arg"
if [[ ! -d "$worktree" ]]; then
  echo "Worktree not found: $worktree" >&2
  echo "Hint: if the agent's worktree was cleaned up, try by PR number instead:" >&2
  echo "  npm run pipeline:test -- <PR#>" >&2
  exit 1
fi

for env_file in ".env" ".env.local" ".env.development" ".env.test" ".env.production"; do
  if [[ ! -e "$worktree/$env_file" && -f "$repo_root/$env_file" ]]; then
    echo "→ symlinking $env_file from main checkout"
    ln -s "$repo_root/$env_file" "$worktree/$env_file"
  fi
done

# Resolve symlinks left over from older runs that shared state with main.
for shared in "node_modules" "data"; do
  if [[ -L "$worktree/$shared" ]]; then
    echo "→ removing stale $shared symlink (will be replaced with an isolated clone)"
    rm "$worktree/$shared"
  fi
done

if [[ ! -e "$worktree/node_modules" && -d "$repo_root/node_modules" ]]; then
  clone_dir "$repo_root/node_modules" "$worktree/node_modules" "node_modules/"
fi

if [[ ! -e "$worktree/data" && -d "$repo_root/data" ]]; then
  clone_dir "$repo_root/data" "$worktree/data" "data/ (postgres / minio / redis state)"
fi

cd "$worktree"
echo "→ npm run dev in $worktree"
exec npm run dev

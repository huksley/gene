#!/usr/bin/env bash
#
# sandbox.sh — build & run the Gene AI sandbox (microsandbox / msb).
#
# The image is built with Docker (see ./Dockerfile) and handed to microsandbox,
# which runs it as a microVM. Two main modes:
#
#   base   rebuild the image from scratch (no cache, fresh pull → redownloads
#          every tool), report the tool versions that landed, load it into msb.
#   run    run a command in a fresh sandbox from the image (no command → shell).
#
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IMAGE="${GENE_SANDBOX_IMAGE:-geneai-sandbox-base}"
TAG="${GENE_SANDBOX_TAG:-latest}"
REF="$IMAGE:$TAG"
DOCKERFILE="${GENE_SANDBOX_DOCKERFILE:-$SCRIPT_DIR/Dockerfile}"
CONTEXT="${GENE_SANDBOX_CONTEXT:-$SCRIPT_DIR}"

# The image runs as this unprivileged user (baked into the Dockerfile as uid 1000).
GUEST_USER="${GENE_SANDBOX_USER:-gene}"
GUEST_HOME="${GENE_SANDBOX_HOME:-/home/$GUEST_USER}"
MEM_DEFAULT="${GENE_SANDBOX_MEMORY:-2G}"

# ── logging: everything goes to stderr so stdout stays clean for reports/cmds ──
if [ -t 2 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B= G= Y= R= N=; fi
log()  { printf '%s==>%s %s\n' "$B$G" "$N" "$*" >&2; }
info() { printf '    %s\n' "$*" >&2; }
warn() { printf '%swarn:%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
strip_ansi() { sed $'s/\x1b\\[[0-9;]*m//g'; }

# Version/env report, executed *inside* the sandbox.
read -r -d '' REPORT <<'EOF' || true
set +e
echo "tools:"
for t in node npm git gh glab linear claude ntn; do
  p="$(command -v "$t" 2>/dev/null)"
  if [ -n "$p" ]; then
    printf "  %-8s %s\n" "$t" "$("$t" --version 2>&1 | head -n1)"
  else
    printf "  %-8s %s\n" "$t" "!! MISSING"
  fi
done
echo "env:"
for k in CLAUDE_CODE_REMOTE_SEND_KEEPALIVES BUN_CONFIG_HTTP_IDLE_TIMEOUT BUN_CONFIG_HTTP_RETRY_COUNT NODE_OPTIONS; do
  printf "  %-34s %s\n" "$k" "${!k}"
done
EOF

# ── host-context inheritance (--inherit) ───────────────────────────────────────
# Env vars proxied into the sandbox when --inherit is set, but only if set on the
# host. Tokens flow straight to the tools: gh←GITHUB_TOKEN, glab←GITLAB_TOKEN/
# GITLAB_HOST, claude←ANTHROPIC_API_KEY & CLAUDE_*, ntn←NOTION_API_TOKEN/NOTION_*,
# plus OPENAI_*/CODEX_*/HUGGINGFACE_TOKEN/NPM_TOKEN. Only key names are ever
# printed — never values.
PROXY_EXACT="ANTHROPIC_API_KEY HUGGINGFACE_TOKEN GITHUB_TOKEN NPM_TOKEN GITLAB_TOKEN GITLAB_HOST OPENAI_TOKEN NOTION_API_TOKEN"
PROXY_GLOBS="CLAUDE_ OPENAI_ CODEX_ NOTION_"
INHERIT_RO="${GENE_SANDBOX_INHERIT_RO:-}"

PROXY_ARGS=(); PROXY_SEEN=""
proxy_add() {  # KEY VALUE — append `-e KEY=VALUE`, deduped by KEY
  case " $PROXY_SEEN " in *" $1 "*) return 0;; esac
  PROXY_SEEN="$PROXY_SEEN $1"
  PROXY_ARGS+=(-e "$1=$2")
}
collect_proxy_env() {
  PROXY_ARGS=(); PROXY_SEEN=""
  local k v g
  for k in $PROXY_EXACT; do
    if v="$(printenv "$k" 2>/dev/null)"; then proxy_add "$k" "$v"; fi
  done
  while IFS='=' read -r k v; do
    [ -n "$k" ] || continue
    for g in $PROXY_GLOBS; do
      case "$k" in "$g"*) proxy_add "$k" "$v"; break;; esac
    done
  done <<EOF
$(printenv)
EOF
}

# Host config/auth dirs → guest paths; each is bind-mounted only if it exists on
# the host (read-write by default; read-only when GENE_SANDBOX_INHERIT_RO is set).
INHERIT_ARGS=(); INHERIT_DESC=()
collect_inherit_mounts() {
  INHERIT_ARGS=(); INHERIT_DESC=()
  local opt=""; [ -n "$INHERIT_RO" ] && opt=":ro"
  local src dst
  while IFS='|' read -r src dst; do
    [ -n "$src" ] || continue
    if [ -e "$src" ]; then
      INHERIT_ARGS+=(-v "$src:$dst$opt")
      INHERIT_DESC+=("$src -> $dst$opt")
    fi
  done <<EOF
$HOME/.claude|$GUEST_HOME/.claude
$HOME/.claude.json|$GUEST_HOME/.claude.json
$HOME/.config/gh|$GUEST_HOME/.config/gh
$HOME/.config/glab-cli|$GUEST_HOME/.config/glab-cli
$HOME/.config/glab|$GUEST_HOME/.config/glab
$HOME/.config/linear|$GUEST_HOME/.config/linear
$HOME/.config/notion|$GUEST_HOME/.config/notion
EOF
}

# ── ephemeral-sandbox cleanup (globals so the EXIT trap can see them) ──────────
SB_NAME=""; SB_KEEP=""
cleanup() {
  [ -n "$SB_KEEP" ] && return 0
  [ -n "$SB_NAME" ] || return 0
  msb stop "$SB_NAME" >/dev/null 2>&1 || true
  msb rm   "$SB_NAME" >/dev/null 2>&1 || true
}

image_in_msb() { msb image ls 2>/dev/null | awk '{print $1}' | grep -qx "$REF"; }

load_into_msb() {
  have msb || die "msb (microsandbox) not found on PATH"
  log "loading $REF into the msb image store"
  docker save "$REF" | msb load -t "$REF" -q
}

ensure_loaded() {
  have msb || die "msb (microsandbox) not found on PATH"
  if image_in_msb; then return 0; fi
  if docker image inspect "$REF" >/dev/null 2>&1; then
    warn "$REF is in Docker but not in the msb store — importing it"
    load_into_msb
  else
    die "$REF not found in msb or Docker. Build it first:  $0 base"
  fi
}

# Boot a throwaway sandbox and print the version/env report from inside it.
report_from_sandbox() {
  local name="geneai-report-$$" rc=0
  msb run --pull never --replace -n "$name" -u "$GUEST_USER" -e "HOME=$GUEST_HOME" -m "$MEM_DEFAULT" \
    -w / "$REF" -- bash -lc "$REPORT" 2>/dev/null | strip_ansi || rc=$?
  msb stop "$name" >/dev/null 2>&1 || true
  msb rm   "$name" >/dev/null 2>&1 || true
  return $rc
}

do_base() {
  have docker || die "docker not found on PATH"
  [ -f "$DOCKERFILE" ] || die "Dockerfile not found at $DOCKERFILE"
  local extra=("$@")
  log "rebuilding $REF (no cache, fresh pull — redownloading all tools)"
  info "dockerfile: $DOCKERFILE    context: $CONTEXT"
  docker build --no-cache --pull --progress=plain -t "$REF" -f "$DOCKERFILE" "${extra[@]}" "$CONTEXT"
  if have msb; then
    load_into_msb
    log "tool versions baked into the freshly built sandbox:"
    report_from_sandbox || warn "could not produce a sandbox report"
  else
    warn "msb not found — skipping sandbox load"
    log "tool versions in the freshly built image:"
    docker run --rm "$REF" bash -lc "$REPORT" | strip_ansi || warn "could not produce a report"
  fi
  log "done. run it with:  $0 run"
}

do_versions() {
  ensure_loaded
  log "tool versions in $REF:"
  report_from_sandbox || die "report failed"
}

do_run() {
  local name="" keep="" detach="" inherit="" workdir="${GENE_SANDBOX_WORKDIR:-/workspace}"
  local cpus="${GENE_SANDBOX_CPUS:-}" mem="$MEM_DEFAULT" user="$GUEST_USER"
  local -a vols=()
  [ -n "${GENE_SANDBOX_VOLUME:-}" ] && vols+=("$GENE_SANDBOX_VOLUME")
  [ -n "${GENE_SANDBOX_INHERIT:-}" ] && inherit=1

  while [ $# -gt 0 ]; do
    case "$1" in
      -n|--name)    name="$2"; keep=1; shift 2;;
      -k|--keep)    keep=1; shift;;
      -d|--detach)  detach=1; keep=1; shift;;
      -i|--inherit) inherit=1; shift;;
      -v|--volume)  vols+=("$2"); shift 2;;
      -w|--workdir) workdir="$2"; shift 2;;
      -c|--cpus)    cpus="$2"; shift 2;;
      -m|--memory)  mem="$2"; shift 2;;
      -u|--user)    user="$2"; shift 2;;
      -h|--help)    usage; exit 0;;
      --)           shift; break;;
      -*)           die "unknown run flag: $1 (see: $0 help)";;
      *)            break;;
    esac
  done
  local -a cmd=("$@")

  [ -n "$name" ] || name="geneai-$$"
  ensure_loaded

  # Always run unprivileged; HOME is set explicitly because msb keeps the image's
  # ENV HOME regardless of -u (so per-user config resolves under the user's home).
  local -a opts=(--pull never --replace -n "$name" -u "$user" -e "HOME=$GUEST_HOME")
  [ -n "$workdir" ] && opts+=(-w "$workdir")
  [ -n "$cpus" ]    && opts+=(-c "$cpus")
  [ -n "$mem" ]     && opts+=(-m "$mem")
  local v; for v in "${vols[@]}"; do opts+=(-v "$v"); done

  if [ -n "$inherit" ]; then
    collect_proxy_env
    collect_inherit_mounts
    log "inheriting host context (running as non-root '$user'):"
    local d
    for d in "${INHERIT_DESC[@]}"; do info "mount  $d"; done
    [ "${#INHERIT_DESC[@]}" -eq 0 ] && info "mount  (no host config dirs found to inherit)"
    if [ -n "$PROXY_SEEN" ]; then info "env   $PROXY_SEEN"; else info "env    (none of the proxied vars are set on the host)"; fi
    [ -z "$INHERIT_RO" ] && warn "--inherit bind-mounts LIVE host credentials read-write; the sandbox can modify them (GENE_SANDBOX_INHERIT_RO=1 for read-only)"
    opts+=("${INHERIT_ARGS[@]}" "${PROXY_ARGS[@]}")
  fi

  [ -n "$detach" ] && opts+=(-d)
  # Allocate a TTY for interactive sessions (attached + on a real terminal).
  if [ -z "$detach" ] && [ -t 0 ] && [ -t 1 ]; then opts+=(-t); fi

  SB_NAME="$name"; SB_KEEP="${keep:-$detach}"
  trap cleanup EXIT INT TERM

  local rc=0
  if [ "${#cmd[@]}" -eq 0 ]; then
    log "starting sandbox '$name' (interactive shell)"
    msb run "${opts[@]}" "$REF" -- bash -l || rc=$?
  else
    log "running in sandbox '$name': ${cmd[*]}"
    msb run "${opts[@]}" "$REF" -- "${cmd[@]}" || rc=$?
  fi
  [ -n "$detach" ] && info "detached. attach: msb exec $name -- bash -l   |   stop: msb rm $name"
  return $rc
}

usage() {
cat >&2 <<'USAGE'
sandbox.sh — build & run the Gene AI sandbox (microsandbox / msb)

Usage:
  ./sandbox.sh base [docker-build-args...]   Rebuild from scratch (no cache, fresh pull):
                                             redownloads every tool, reports the versions
                                             that landed, then loads the image into msb.
  ./sandbox.sh run  [flags] [-- cmd...]      Run cmd in a fresh sandbox (no cmd → shell).
  ./sandbox.sh versions                      Report tool versions in the current image.
  ./sandbox.sh help

Sandboxes run as the unprivileged user 'gene' (uid 1000) with 2G memory by default.

run flags:
  -i, --inherit       bring host tool auth/context into the sandbox (see below)
  -n, --name NAME     name the sandbox (named sandboxes are kept, not auto-removed)
  -k, --keep          keep the sandbox after the command exits
  -d, --detach        start in the background and print the name
  -v, --volume SPEC   mount host:guest[:opts] into the sandbox (repeatable)
  -w, --workdir DIR   working directory inside the sandbox (default: /workspace)
  -c, --cpus N        number of vCPUs
  -m, --memory SIZE   memory, e.g. 2G            (default: 2G)
  -u, --user USER     run as this guest user      (default: gene)

--inherit brings your host identity into the otherwise-isolated sandbox:
  • bind-mounts each tool's host config dir that exists, read-write:
      ~/.claude, ~/.claude.json, ~/.config/{gh,glab-cli,glab,linear,notion}
  • proxies these env vars when set (values never printed):
      ANTHROPIC_API_KEY HUGGINGFACE_TOKEN GITHUB_TOKEN NPM_TOKEN GITLAB_TOKEN
      GITLAB_HOST OPENAI_TOKEN NOTION_API_TOKEN  and  CLAUDE_* OPENAI_* CODEX_* NOTION_*
  WARNING: mounts are read-write — the sandbox can modify your real credentials.
           Set GENE_SANDBOX_INHERIT_RO=1 to mount them read-only instead.

Examples:
  ./sandbox.sh base
  ./sandbox.sh base --build-arg GLAB_VERSION=1.103.0
  ./sandbox.sh run                                  # interactive shell (as gene, 2G)
  ./sandbox.sh run claude --version
  ./sandbox.sh run --inherit -- claude -p 'summarize the open Linear issues'
  GENE_SANDBOX_INHERIT_RO=1 ./sandbox.sh run --inherit                 # read-only auth
  ./sandbox.sh run -v "$PWD:/workspace" -- bash -lc 'cd /workspace && npm test'

Env overrides: GENE_SANDBOX_IMAGE, GENE_SANDBOX_TAG, GENE_SANDBOX_DOCKERFILE,
  GENE_SANDBOX_CONTEXT, GENE_SANDBOX_VOLUME, GENE_SANDBOX_WORKDIR,
  GENE_SANDBOX_CPUS, GENE_SANDBOX_MEMORY, GENE_SANDBOX_USER, GENE_SANDBOX_HOME,
  GENE_SANDBOX_INHERIT (=1 to always inherit), GENE_SANDBOX_INHERIT_RO (=1 read-only)
USAGE
}

main() {
  local mode="${1:-help}"; shift || true
  case "$mode" in
    base|build|rebuild|update) do_base "$@";;
    run|shell)                 do_run "$@";;
    versions|version|report)   do_versions;;
    help|-h|--help)            usage;;
    *) die "unknown mode: '$mode'  (try: $0 help)";;
  esac
}
main "$@"

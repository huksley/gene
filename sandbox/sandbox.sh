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
MEM_DEFAULT="${GENE_SANDBOX_MEMORY:-4G}"

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
for t in node npm git gh glab linear claude ntn docker; do
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
# trello←TRELLO_API_KEY/TRELLO_TOKEN/TRELLO_*, plus OPENAI_*/CODEX_*/
# HUGGINGFACE_TOKEN/NPM_TOKEN. Only key names are ever printed — never values.
PROXY_EXACT="ANTHROPIC_API_KEY HUGGINGFACE_TOKEN GITHUB_TOKEN NPM_TOKEN GITLAB_TOKEN GITLAB_HOST OPENAI_TOKEN NOTION_API_TOKEN TRELLO_API_KEY TRELLO_TOKEN"
PROXY_GLOBS="CLAUDE_ OPENAI_ CODEX_ NOTION_ TRELLO_"
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
$HOME/.config/gh|$GUEST_HOME/.config/gh
$HOME/.config/glab-cli|$GUEST_HOME/.config/glab-cli
$HOME/.config/glab|$GUEST_HOME/.config/glab
$HOME/.config/linear|$GUEST_HOME/.config/linear
$HOME/.config/notion|$GUEST_HOME/.config/notion
EOF
}

# macOS keeps Claude Code's OAuth login in the Keychain, not on disk — so the
# ~/.claude bind-mount alone won't carry it into the (Linux) sandbox, where
# Claude Code instead reads ~/.claude/.credentials.json. Bridge the two: copy the
# Keychain blob into that 0600 file just before the run, so it rides the existing
# ~/.claude mount in. The token is never printed; on ephemeral runs the file is
# removed afterward (GENE_SANDBOX_KEEP_CREDENTIALS=1 keeps it on the host;
# GENE_SANDBOX_NO_KEYCHAIN=1 skips the bridge). A pre-existing file is left alone.
stage_claude_credentials() {
  [ -n "${GENE_SANDBOX_NO_KEYCHAIN:-}" ] && return 0
  [ "$(uname -s)" = "Darwin" ] || return 0          # only macOS hides it in the Keychain
  have security || return 0
  local f="$HOME/.claude/.credentials.json"
  if [ -e "$f" ]; then
    info "claude  login: using existing ~/.claude/.credentials.json"
    return 0
  fi
  if ! security find-generic-password -s "Claude Code-credentials" -a "$USER" >/dev/null 2>&1; then
    info "claude  login: none in Keychain (run 'claude' to log in) — sandbox claude unauthenticated"
    return 0
  fi
  mkdir -p "$HOME/.claude"
  local tmp="$f.staging.$$"
  if ( umask 077; security find-generic-password -s "Claude Code-credentials" -a "$USER" -w >"$tmp" 2>/dev/null ) && [ -s "$tmp" ]; then
    chmod 600 "$tmp"; mv -f "$tmp" "$f"
    if [ -n "${GENE_SANDBOX_KEEP_CREDENTIALS:-}" ]; then
      info "claude  login: bridged Keychain -> ~/.claude/.credentials.json (0600, kept)"
    else
      STAGED_CRED_FILE="$f"
      info "claude  login: bridged Keychain -> ~/.claude/.credentials.json (0600, removed after run)"
    fi
  else
    rm -f "$tmp"
    warn "claude  login: Keychain read denied — sandbox claude may be unauthenticated"
  fi
}

# Pre-trust the sandbox workdir so non-interactive `claude -p` doesn't block on the
# "Do you trust the files in this folder?" dialog. Claude Code records trust in
# ~/.claude.json under projects.<dir>.hasTrustDialogAccepted — but the host file is
# keyed by HOST paths (never /workspace). So we stage a COPY of the host config
# (preserving onboarding/MCP/global flags) with the workdir(s) marked trusted, and
# mount that as the guest's ~/.claude.json (set in CLAUDE_CFG_MOUNT). The copy
# replaces the live mount, so the sandbox no longer writes its own state back into
# your real ~/.claude.json. Removed after ephemeral runs (kept for -k/-d).
CLAUDE_CFG_MOUNT=""
stage_claude_config() {
  local guest_dst="$1"; shift
  local dirs="$*"                      # space-separated guest dirs to trust
  local host_cfg="$HOME/.claude.json"
  local tmp="${TMPDIR:-/tmp}/geneai-claude-json.$$"
  local ok=""
  CLAUDE_CFG_MOUNT=""

  if have python3; then
    if CJ_HOST="$host_cfg" CJ_DIRS="$dirs" python3 - "$tmp" <<'PY' 2>/dev/null
import json, os, sys
out = sys.argv[1]
host = os.environ.get("CJ_HOST", "")
dirs = os.environ.get("CJ_DIRS", "").split()
data = {}
if host and os.path.exists(host):
    try:
        data = json.load(open(host))
    except Exception:
        data = {}
if not isinstance(data, dict):
    data = {}
proj = data.get("projects")
if not isinstance(proj, dict):
    proj = {}
    data["projects"] = proj
for d in dirs:
    e = proj.get(d)
    if not isinstance(e, dict):
        e = {}
        proj[d] = e
    e["hasTrustDialogAccepted"] = True
json.dump(data, open(out, "w"))
PY
    then ok=1; fi
  elif have jq; then
    local body="" d
    for d in $dirs; do body="$body | .projects[\"$d\"].hasTrustDialogAccepted = true"; done
    if [ -e "$host_cfg" ]; then
      jq ". $body" "$host_cfg" >"$tmp" 2>/dev/null && ok=1
    else
      jq -n "{} $body" >"$tmp" 2>/dev/null && ok=1
    fi
  fi

  if [ -n "$ok" ] && [ -s "$tmp" ]; then
    chmod 600 "$tmp" 2>/dev/null || true
    STAGED_CONFIG_FILE="$tmp"
    CLAUDE_CFG_MOUNT="$tmp:$guest_dst${INHERIT_RO:+:ro}"
    info "claude  trust: [$dirs] pre-trusted in ~/.claude.json (staged copy of host config)"
  else
    rm -f "$tmp" 2>/dev/null
    if [ -e "$host_cfg" ]; then
      CLAUDE_CFG_MOUNT="$host_cfg:$guest_dst${INHERIT_RO:+:ro}"
      warn "claude  trust: no python3/jq to inject trust — mounting live ~/.claude.json (trust dialog may block)"
    else
      warn "claude  trust: no ~/.claude.json and no python3/jq — workdir not pre-trusted"
    fi
  fi
}

# ── ephemeral-sandbox cleanup (globals so the EXIT trap can see them) ──────────
SB_NAME=""; SB_KEEP=""; STAGED_CRED_FILE=""; STAGED_CONFIG_FILE=""
cleanup() {
  [ -n "$SB_KEEP" ] && return 0
  # Drop the transient files staged for this run (the Keychain-bridged credential
  # and the trust-injected ~/.claude.json copy). Ephemeral runs only — kept/detached
  # sandboxes returned above still have them mounted.
  [ -n "$STAGED_CRED_FILE" ]   && rm -f "$STAGED_CRED_FILE" 2>/dev/null
  [ -n "$STAGED_CONFIG_FILE" ] && rm -f "$STAGED_CONFIG_FILE" 2>/dev/null
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
  local internal="" internal_set="" mount_dir="" workdir_set="${GENE_SANDBOX_WORKDIR:+1}" docker_d=""
  local -a vols=()
  [ -n "${GENE_SANDBOX_VOLUME:-}" ] && vols+=("$GENE_SANDBOX_VOLUME")
  [ -n "${GENE_SANDBOX_INHERIT:-}" ] && inherit=1
  [ -n "${GENE_SANDBOX_INTERNAL:-}" ] && { internal=1; internal_set=1; }
  [ -n "${GENE_SANDBOX_DOCKER:-}" ] && docker_d=1

  while [ $# -gt 0 ]; do
    case "$1" in
      -n|--name)    name="$2"; keep=1; shift 2;;
      -k|--keep)    keep=1; shift;;
      -d|--detach)  detach=1; keep=1; shift;;
      -i|--inherit) inherit=1; shift;;
      --internal|--net-host)    internal=1; internal_set=1; shift;;
      --isolated|--no-internal) internal=""; internal_set=1; shift;;
      --docker)                 docker_d=1; shift;;
      --no-docker)              docker_d=""; shift;;
      -v|--volume)  vols+=("$2"); shift 2;;
      --dir)        mount_dir="$2"; shift 2;;
      --pwd)        mount_dir="$PWD"; shift;;
      -w|--workdir) workdir="$2"; workdir_set=1; shift 2;;
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

  # --dir DIR: mount a host directory into the sandbox at /workspace/<basename>
  # (NOT at /workspace itself) and — unless -w was given — make it the workdir. So
  # you land in your project, and with --inherit that dir is the one pre-trusted for
  # claude. The mount auto-creates /workspace/<basename>. --pwd is --dir "$PWD".
  # DIR may be relative; it's resolved to an absolute path (and must exist).
  if [ -n "$mount_dir" ]; then
    local dir_abs dir_base dir_dst
    dir_abs="$(cd "$mount_dir" 2>/dev/null && pwd)" || die "--dir: not a directory: $mount_dir"
    dir_base="$(basename "$dir_abs")"
    [ -n "$dir_base" ] && [ "$dir_base" != "/" ] || die "--dir: cannot derive a directory name from: $mount_dir"
    dir_dst="/workspace/$dir_base"
    vols+=("$dir_abs:$dir_dst")
    if [ -z "$workdir_set" ]; then workdir="$dir_dst"; info "dir    mounting $dir_abs -> $dir_dst (workdir)"; else info "dir    mounting $dir_abs -> $dir_dst"; fi
  fi

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
    log "inheriting host context (running as non-root '$user'):"
    local trust_dirs="${workdir:-/workspace}"
    [ -n "${GENE_SANDBOX_TRUST_DIRS:-}" ] && trust_dirs="$trust_dirs $GENE_SANDBOX_TRUST_DIRS"
    collect_proxy_env
    stage_claude_credentials                                  # macOS: Keychain login -> ~/.claude/.credentials.json
    stage_claude_config "$GUEST_HOME/.claude.json" $trust_dirs  # workdir trust -> staged ~/.claude.json (word-split intended)
    collect_inherit_mounts
    local d
    for d in "${INHERIT_DESC[@]}"; do info "mount  $d"; done
    [ "${#INHERIT_DESC[@]}" -eq 0 ] && info "mount  (no host config dirs found to inherit)"
    if [ -n "$PROXY_SEEN" ]; then info "env   $PROXY_SEEN"; else info "env    (none of the proxied vars are set on the host)"; fi
    [ -z "$INHERIT_RO" ] && warn "--inherit bind-mounts LIVE host credentials read-write; the sandbox can modify them (GENE_SANDBOX_INHERIT_RO=1 for read-only)"
    opts+=("${INHERIT_ARGS[@]}" "${PROXY_ARGS[@]}")
    [ -n "$CLAUDE_CFG_MOUNT" ] && opts+=(-v "$CLAUDE_CFG_MOUNT")
  fi

  # Authenticated real work (--inherit) might target internal hosts
  # so turn on internal networking alongside it (--internal) — unless the user
  # explicitly asked for isolation.
  if [ -n "$inherit" ] && [ -z "$internal_set" ]; then internal=1; fi

  if [ -n "$internal" ]; then
    # msb's default egress is deny-all-but-public, and it drops DNS answers that
    # resolve to private IPs (rebind protection) — which blocks internal hosts
    # like gitlab.example.com (i.e. a 10.x reached via a Tailscale subnet route).
    # Unrestricting egress + disabling rebind protection lets the sandbox use the
    # host's full reach; msb's DNS forwarder already points at the host resolver.
    opts+=(--net-default-egress allow --no-dns-rebind-protection)
    log "network: internal ON — private/Tailscale hosts reachable, egress unrestricted"
  else
    info "network: isolated — public egress only (use --internal for private/Tailscale hosts)"
  fi

  # Optional in-sandbox Docker daemon: msb --init hands PID 1 to the dockerd
  # launcher (root); the command below runs alongside as gene and reaches the
  # socket via the docker group. dockerd needs egress to pull images — the default
  # public-egress rule covers public registries (use --internal for private ones).
  # Requires an image built with the docker layer (./sandbox.sh base).
  if [ -n "$docker_d" ]; then
    opts+=(--init /usr/local/bin/sandbox-dockerd-init)
    log "docker: in-sandbox dockerd ON (PID 1; iptables off — use 'docker --network=host' for egress)"
    if [ "${#cmd[@]}" -gt 0 ]; then
      # gate the command on daemon readiness so it doesn't race dockerd startup
      local dwait="${GENE_DOCKER_WAIT:-60}"
      cmd=(bash -lc "wait-for-docker $dwait || exit 1; exec \"\$@\"" _ "${cmd[@]}")
    else
      info "docker: interactive — run 'wait-for-docker' to block until the daemon is ready"
    fi
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
      --internal      reach private/internal hosts (RFC1918, Tailscale subnet
                      routes) — e.g. gitlab.example.com; implied by --inherit
      --isolated      force public-egress-only, even with --inherit (--no-internal)
      --docker        start dockerd inside the sandbox (msb --init hands it PID 1);
                      experimental — iptables off, so pass 'docker --network=host'
                      for build/run egress; needs an image built with the docker
                      layer (./sandbox.sh base)
  -n, --name NAME     name the sandbox (named sandboxes are kept, not auto-removed)
  -k, --keep          keep the sandbox after the command exits
  -d, --detach        start in the background and print the name
  -v, --volume SPEC   mount host:guest[:opts] into the sandbox (repeatable)
      --dir DIR       mount host DIR at /workspace/<basename> and make it the workdir
                      (so claude --inherit pre-trusts it); not at /workspace itself
      --pwd           shortcut for --dir "$PWD" (mount the current directory)
  -w, --workdir DIR   working directory inside the sandbox (default: /workspace)
  -c, --cpus N        number of vCPUs
  -m, --memory SIZE   memory, e.g. 2G            (default: 2G)
  -u, --user USER     run as this guest user      (default: gene)

--inherit brings your host identity into the otherwise-isolated sandbox:
  • bind-mounts each tool's host config dir that exists, read-write:
      ~/.claude, ~/.config/{gh,glab-cli,glab,linear,notion}
  • stages a copy of ~/.claude.json with the workdir (default /workspace) marked
      trusted (projects.<dir>.hasTrustDialogAccepted=true) so `claude -p` won't
      block on the folder-trust dialog. The copy — not the live file — is mounted,
      so the sandbox can't write its state back to your real ~/.claude.json. Add
      more trusted dirs with GENE_SANDBOX_TRUST_DIRS="dir1 dir2".
  • proxies these env vars when set (values never printed):
      ANTHROPIC_API_KEY HUGGINGFACE_TOKEN GITHUB_TOKEN NPM_TOKEN GITLAB_TOKEN
      GITLAB_HOST OPENAI_TOKEN NOTION_API_TOKEN TRELLO_API_KEY TRELLO_TOKEN
      and  CLAUDE_* OPENAI_* CODEX_* NOTION_* TRELLO_*
  • on macOS, bridges your Claude Code Keychain login into a 0600
      ~/.claude/.credentials.json so the (Linux) sandbox's claude is logged in —
      macOS hides the token in the Keychain, which the mount alone can't carry.
      The file is removed after the run (GENE_SANDBOX_KEEP_CREDENTIALS=1 to keep it,
      GENE_SANDBOX_NO_KEYCHAIN=1 to skip the bridge).
  WARNING: mounts are read-write — the sandbox can modify your real credentials.
           Set GENE_SANDBOX_INHERIT_RO=1 to mount them read-only instead.
  --inherit also turns on --internal (real work usually needs the internal
  network); pass --isolated to keep public-egress-only.

Network: a bare `run` is isolated — only public egress is allowed and DNS
  answers that resolve to private IPs are dropped (msb defaults). --internal
  lifts both so the sandbox reaches whatever the host can (incl. Tailscale).

Examples:
  ./sandbox.sh base
  ./sandbox.sh base --build-arg GLAB_VERSION=1.103.0
  ./sandbox.sh run                                  # interactive shell (as gene, 2G)
  ./sandbox.sh run claude --version
  ./sandbox.sh run --inherit -- claude -p 'summarize the open Linear issues'
  ./sandbox.sh run --internal -- glab -R group/repo mr list            # internal GitLab
  ./sandbox.sh run --inherit --isolated -- claude --version            # creds, no internal net
  GENE_SANDBOX_INHERIT_RO=1 ./sandbox.sh run --inherit                 # read-only auth
  ./sandbox.sh run --pwd -- bash -lc 'npm test'         # mount cwd at /workspace/<name>, cd there
  ./sandbox.sh run --dir ~/src/myrepo --inherit -- claude -p 'fix the bug'  # mount that repo + trust it
  ./sandbox.sh run --pwd --inherit -- claude -p 'fix the failing test'   # cwd mounted + trusted
  ./sandbox.sh run -v "$PWD:/workspace" -- bash -lc 'cd /workspace && npm test'
  ./sandbox.sh run --docker -- bash -lc 'docker build --network=host -t demo .'   # dockerd in-sandbox

Env overrides: GENE_SANDBOX_IMAGE, GENE_SANDBOX_TAG, GENE_SANDBOX_DOCKERFILE,
  GENE_SANDBOX_CONTEXT, GENE_SANDBOX_VOLUME, GENE_SANDBOX_WORKDIR,
  GENE_SANDBOX_CPUS, GENE_SANDBOX_MEMORY, GENE_SANDBOX_USER, GENE_SANDBOX_HOME,
  GENE_SANDBOX_INHERIT (=1 to always inherit), GENE_SANDBOX_INHERIT_RO (=1 read-only),
  GENE_SANDBOX_INTERNAL (=1 to always allow internal/private network access),
  GENE_SANDBOX_DOCKER (=1 to always start the in-sandbox dockerd; see --docker),
  GENE_DOCKER_WAIT (seconds wait-for-docker blocks for daemon readiness; default 60),
  GENE_SANDBOX_KEEP_CREDENTIALS (=1 keep the bridged claude creds file on the host),
  GENE_SANDBOX_NO_KEYCHAIN (=1 skip the macOS Keychain → credentials.json bridge),
  GENE_SANDBOX_TRUST_DIRS (space-separated extra guest dirs to pre-trust for claude)
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

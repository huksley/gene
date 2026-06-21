#!/usr/bin/env bash
#
# gene installer — download the latest prebuilt binary and drop it on your PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/huksley/gene/main/install.sh | bash
#
# Options (pass after `-s --` when piping, e.g. `... | bash -s -- --dir ~/bin`):
#   --dir DIR          install into DIR (default: /usr/local/bin if writable, else ~/.local/bin)
#   --version TAG      install a specific release tag instead of the latest
#   -h, --help         show this help
#
# Environment overrides: GENE_INSTALL_DIR, GENE_VERSION, GH_TOKEN (lifts the
# GitHub API rate limit). Prebuilt releases are macOS arm64 only.

set -euo pipefail

OWNER="huksley"
REPO="gene"
BIN="gene"
# Assets to try, in priority order. Published assets are gzipped (.gz) and decompressed
# on install; the plain names are a fallback for older releases. Keep in sync with
# ASSET_CANDIDATES in src/update.ts.
ASSET_CANDIDATES=("gene-darwin-arm64.gz" "gene-macos-arm64.gz" "gene.gz" "gene-darwin-arm64" "gene-macos-arm64" "gene")

INSTALL_DIR="${GENE_INSTALL_DIR:-}"
VERSION="${GENE_VERSION:-}"

say()  { printf '\033[36m[gene:install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[gene:install]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[gene:install]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  # Print the leading comment block (minus the shebang), stripping "# ", and stop at
  # the first non-comment line. Robust to the header growing; no-ops when piped (no $0 file).
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0" 2>/dev/null || true
  exit 0
}

# ---- parse args ----------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)     INSTALL_DIR="${2:-}"; shift 2 ;;
    --dir=*)   INSTALL_DIR="${1#*=}"; shift ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    -h|--help) usage ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ---- platform check ------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
  die "prebuilt releases are macOS arm64 only (this is ${OS}/${ARCH})."
fi

# ---- pick an HTTP client -------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  HTTP="curl"
elif command -v wget >/dev/null 2>&1; then
  HTTP="wget"
else
  die "need curl or wget to download."
fi

# fetch_to URL DEST -> 0 on success (HTTP 2xx), non-zero otherwise. Quiet.
# Written without empty-array expansion so it works on macOS's stock bash 3.2,
# where `"${arr[@]}"` on an empty array trips `set -u`.
fetch_to() {
  local url="$1" dest="$2"
  if [ "$HTTP" = "curl" ]; then
    if [ -n "${GH_TOKEN:-}" ]; then
      curl -fSL --retry 3 -H "Authorization: Bearer ${GH_TOKEN}" -o "$dest" "$url" 2>/dev/null
    else
      curl -fSL --retry 3 -o "$dest" "$url" 2>/dev/null
    fi
  else
    if [ -n "${GH_TOKEN:-}" ]; then
      wget -q --header="Authorization: Bearer ${GH_TOKEN}" -O "$dest" "$url"
    else
      wget -q -O "$dest" "$url"
    fi
  fi
}

# ---- resolve install dir -------------------------------------------------
if [ -z "$INSTALL_DIR" ]; then
  if [ -w /usr/local/bin ] 2>/dev/null; then
    INSTALL_DIR="/usr/local/bin"
  else
    INSTALL_DIR="${HOME}/.local/bin"
  fi
fi
mkdir -p "$INSTALL_DIR" || die "cannot create install dir: $INSTALL_DIR"
[ -w "$INSTALL_DIR" ] || die "install dir is not writable: $INSTALL_DIR (try: sudo, or --dir ~/.local/bin)"

# ---- build the base download URL ----------------------------------------
if [ -n "$VERSION" ]; then
  BASE="https://github.com/${OWNER}/${REPO}/releases/download/${VERSION}"
  say "installing gene ${VERSION} → ${INSTALL_DIR}/${BIN}"
else
  BASE="https://github.com/${OWNER}/${REPO}/releases/latest/download"
  say "installing the latest gene → ${INSTALL_DIR}/${BIN}"
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/gene-install.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ---- download the first asset that exists --------------------------------
RAW="${TMP}/asset"
ASSET=""
for candidate in "${ASSET_CANDIDATES[@]}"; do
  if fetch_to "${BASE}/${candidate}" "$RAW"; then
    ASSET="$candidate"
    break
  fi
done
[ -n "$ASSET" ] || die "no macOS arm64 asset found at ${BASE} (looked for: ${ASSET_CANDIDATES[*]}). Are there published releases?"
[ -s "$RAW" ] || die "downloaded file is empty."
say "downloaded ${ASSET} ($(($(wc -c <"$RAW") / 1000000)) MB)"

# ---- optional checksum verification of the downloaded asset (best effort) ----
if fetch_to "${BASE}/${ASSET}.sha256" "${TMP}/sum"; then
  SUMTOOL=""
  command -v shasum >/dev/null 2>&1 && SUMTOOL="shasum -a 256"
  [ -z "$SUMTOOL" ] && command -v sha256sum >/dev/null 2>&1 && SUMTOOL="sha256sum"
  if [ -n "$SUMTOOL" ]; then
    want="$(awk '{print $1}' "${TMP}/sum")"
    got="$($SUMTOOL "$RAW" | awk '{print $1}')"
    if [ -n "$want" ] && [ "$want" != "$got" ]; then
      die "checksum mismatch (expected ${want}, got ${got}) — refusing to install."
    fi
    say "checksum verified."
  fi
fi

# ---- decompress if the asset is gzipped ----------------------------------
DL="${TMP}/${BIN}"
case "$ASSET" in
  *.gz)
    say "decompressing…"
    if command -v gzip >/dev/null 2>&1; then
      gzip -dc "$RAW" > "$DL" || die "failed to decompress ${ASSET} (corrupt download?)."
    elif command -v gunzip >/dev/null 2>&1; then
      gunzip -c "$RAW" > "$DL" || die "failed to decompress ${ASSET} (corrupt download?)."
    else
      die "need gzip (or gunzip) to decompress ${ASSET}."
    fi
    ;;
  *)
    mv -f "$RAW" "$DL"
    ;;
esac
[ -s "$DL" ] || die "binary is empty after unpacking."

# ---- make it runnable ----------------------------------------------------
chmod 0755 "$DL"
# Ad-hoc sign + clear quarantine so Gatekeeper allows it. Both best-effort.
command -v codesign >/dev/null 2>&1 && codesign --sign - --force "$DL" >/dev/null 2>&1 || true
command -v xattr    >/dev/null 2>&1 && xattr -d com.apple.quarantine "$DL" >/dev/null 2>&1 || true

# ---- move into place (atomic within the same filesystem) -----------------
DEST="${INSTALL_DIR}/${BIN}"
mv -f "$DL" "$DEST" || die "failed to move binary into ${DEST}"

# ---- verify --------------------------------------------------------------
if ! "$DEST" --version >/dev/null 2>&1; then
  die "installed binary failed to run ($DEST --version). It may be blocked by Gatekeeper — try: xattr -d com.apple.quarantine $DEST"
fi
say "✓ installed $("$DEST" --version 2>/dev/null || echo gene) at ${DEST}"

# ---- PATH guidance -------------------------------------------------------
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) : ;;
  *)
    warn "${INSTALL_DIR} is not on your PATH. Add it, e.g.:"
    warn "  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.zshrc && exec \$SHELL"
    ;;
esac

say "run 'gene --help' to get started."

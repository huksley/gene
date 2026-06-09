# syntax=docker/dockerfile:1

# ──────────────────────────────────────────────────────────────────────────────
# Gene AI — sandbox base image
#
# Toolchain for the Gene AI pipeline and the `claude -p` agents it spawns:
#   • git + Node.js 24   the daemon runs `node src/index.ts` inside git worktrees
#   • claude             Anthropic Claude Code — the agent runtime
#   • gh                 GitHub CLI       (github.com repos / PRs)
#   • glab               GitLab CLI       (gitlab.* repos / MRs)
#   • linear             schpet/linear-cli (Linear issues / comments)
#   • ntn                Notion CLI (ntn.dev) — Notion API / pages / workers
#
# This is a *base* image — it ships the toolchain only, no application code.
# Build your app/agent image `FROM` this, or mount the repo at /workspace.
# ──────────────────────────────────────────────────────────────────────────────
FROM ubuntu:24.04

LABEL org.opencontainers.image.title="geneai-sandbox-base" \
      org.opencontainers.image.description="Base sandbox image for the Gene AI pipeline (claude, gh, glab, linear, ntn)"

# Pin-able tool versions (override with `--build-arg`).
ARG NODE_MAJOR=24
ARG GLAB_VERSION=1.102.0
ARG CLAUDE_VERSION=2.1.168
ARG NTN_VERSION=latest

# ── Telemetry / nag suppression ───────────────────────────────────────────────
# Opt the toolchain out of metrics, update-notifier nags, and "thanks for
# installing" banners, and force apt fully non-interactive. Set as ENV (not ARG)
# so they apply during this build *and* persist for the `claude -p` agents at
# runtime; DEBIAN_FRONTEND=noninteractive replaces the former build-only ARG, so
# apt never prompts — whether building the image or running it as a sandbox.
ENV SEMGREP_SEND_METRICS=off \
    COLLECT_LEARNINGS_OPT_OUT=true \
    STORYBOOK_DISABLE_TELEMETRY=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    SLS_TELEMETRY_DISABLED=1 \
    SLS_NOTIFICATIONS_MODE=off \
    DISABLE_OPENCOLLECTIVE=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    DEBIAN_FRONTEND=noninteractive

# ── OS packages ───────────────────────────────────────────────────────────────
# curl + unzip are the requested base; git is required by the worktree pipeline;
# ca-certificates + gnupg back the signed apt repos added below; xz-utils unpacks
# the linear-cli release tarball (.tar.xz); jq + less are everyday companions for
# the gh/glab/linear JSON output and pagers.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        unzip \
        xz-utils \
        git \
        gnupg \
        jq \
        less; \
    rm -rf /var/lib/apt/lists/*

# ── git: trust bind-mounted worktrees ──────────────────────────────────────────
# The daemon bind-mounts host git worktrees into the VM at their real paths; the
# files keep the host's uid, which differs from the guest `gene` user, so git's
# "dubious ownership" guard would otherwise refuse every command (status, commit,
# push). This is a throwaway single-purpose sandbox, so trust any repo path,
# system-wide (applies to every user, including gene).
RUN git config --system --add safe.directory '*'

# ── apt repos: GitHub CLI · Node.js (NodeSource) ──────────────────────────────
RUN set -eux; \
    install -d -m 0755 /etc/apt/keyrings; \
    \
    # GitHub CLI (gh)
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list; \
    \
    # Node.js — adds the NodeSource repo and refreshes all repos via apt-get update
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -; \
    \
    apt-get install -y --no-install-recommends nodejs gh; \
    rm -rf /var/lib/apt/lists/*

# ── glab (GitLab CLI) — official prebuilt release binary, multi-arch ───────────
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    curl -fsSL \
        "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${arch}.tar.gz" \
        -o /tmp/glab.tar.gz; \
    mkdir -p /tmp/glab; \
    tar -xzf /tmp/glab.tar.gz -C /tmp/glab; \
    install -m 0755 "$(find /tmp/glab -type f -name glab | head -n1)" /usr/local/bin/glab; \
    rm -rf /tmp/glab /tmp/glab.tar.gz

# ── linear (schpet/linear-cli) — npm global; postinstall fetches the binary ────
RUN set -eux; \
    npm install -g @schpet/linear-cli; \
    npm cache clean --force

# ── Non-root user ──────────────────────────────────────────────────────────────
# The sandbox runs unprivileged — the daemon's `claude -p` agents must not be
# root. Claim uid/gid 1000 by swapping Ubuntu's stock `ubuntu` user for a
# dedicated `gene`, and pre-create its config dir + the workspace (gene-owned).
# HOME is set here so the tool installers below land under /home/gene and the
# runtime finds per-user config there.
RUN set -eux; \
    if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu; fi; \
    if getent group ubuntu >/dev/null 2>&1; then groupdel ubuntu; fi; \
    groupadd --gid 1000 gene; \
    useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash gene; \
    install -d -o gene -g gene /home/gene/.config /workspace
ENV HOME=/home/gene

# ── claude (Claude Code) — official native CLI installer, pinned version ───────
# The installer drops the binary in $HOME/.local/bin; symlink it onto the system
# PATH so `claude` resolves for every shell and for the daemon's `claude -p` exec.
RUN set -eux; \
    curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}"; \
    ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude; \
    claude --version

# ── ntn (Notion CLI) — official native installer, into $HOME/.local/bin ────────
# Same pattern as claude: the installer writes the binary to $HOME/.local/bin
# (per the NTN_INSTALL_DIR override), so symlink it onto the system PATH. ntn
# ships a static musl binary (no extra runtime libs) and verifies the download
# against its .sha256 checksum. NTN_VERSION pins the release (default: latest).
RUN set -eux; \
    curl -fsSL "https://ntn.dev" | NTN_INSTALL_DIR="$HOME/.local/bin" NTN_VERSION="${NTN_VERSION}" bash; \
    ln -sf "$HOME/.local/bin/ntn" /usr/local/bin/ntn; \
    ntn --version

# The installers above ran as root with HOME=/home/gene, so hand the whole home
# (binaries, claude's version data, anything they touched) to the unprivileged user.
RUN set -eux; chown -R gene:gene /home/gene /workspace

# ── docker (Docker CE) — engine + CLI + buildx/compose, for builds in-sandbox ──
# Docker's signed apt repo, then the engine, CLI, containerd, and the buildx/
# compose plugins; finally add `gene` to the docker group so the unprivileged
# user can reach the daemon socket. The daemon is NOT started here — `docker
# build` has no init — so dockerd must be launched at runtime (the microVM has to
# run privileged, with cgroup/overlay support) before `docker` works in-sandbox.
RUN set -eux; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; \
    rm -rf /var/lib/apt/lists/*; \
    getent group docker || groupadd docker; \
    usermod -aG docker gene

# ── Runtime environment ───────────────────────────────────────────────────────
# Keep long-lived agent connections alive and make Node/Bun networking resilient
# inside the sandbox. Claude Code's native binary is Bun-compiled, so it honours
# the BUN_CONFIG_* knobs; NODE_OPTIONS applies to the daemon and linear-cli.
# DISABLE_AUTOUPDATER pins the CLI-installed claude to the built-in version, so
# ephemeral sandboxes stay reproducible instead of self-updating on launch.
# NOTION_KEYRING=0 makes `ntn` use file-based auth (~/.config/notion/auth.json)
# or NOTION_API_TOKEN — the microVM has no OS keyring / Secret Service.
ENV CLAUDE_CODE_REMOTE_SEND_KEEPALIVES=true \
    BUN_CONFIG_HTTP_IDLE_TIMEOUT=300 \
    BUN_CONFIG_HTTP_RETRY_COUNT=3 \
    NODE_OPTIONS=--dns-result-order=ipv4first \
    DISABLE_AUTOUPDATER=1 \
    NOTION_KEYRING=0

# Drop to the unprivileged user for the sanity check and at runtime.
USER gene

# ── Sanity check — fail the build early if any tool is missing/broken ──────────
# Runs as `gene`, so it doubles as proof every tool works for the non-root user.
RUN set -eux; \
    node --version; \
    npm --version; \
    git --version; \
    gh --version; \
    glab --version; \
    linear --version; \
    claude --version; \
    ntn --version; \
    docker --version

WORKDIR /workspace
CMD ["bash"]

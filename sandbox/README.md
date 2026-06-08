# Sandbox

The isolated runtime for the Gene AI toolchain. A **base image** (the CLIs only —
`claude`, `gh`, `glab`, `linear`, `ntn` on Node 24, no application code) built with
Docker and run as a **microVM** by [microsandbox](https://microsandbox.dev) (`msb`),
driven by `sandbox.sh`.

> **Why a microVM, not a container?** The daemon spawns `claude -p` agents that
> edit code, run commands, and push branches. `msb` gives each run a throwaway VM
> with its own kernel and a deny-by-default network, so an agent can't reach the
> host or the wider network unless you let it (`--inherit` / `--internal`).

The image carries **only the toolchain** — there are no `COPY`/`ADD` steps, so the
build context is tiny. Run your repo inside it with `--pwd` or `-v`, or build your
own app image `FROM geneai-sandbox-base`.

## Prerequisites

| tool   | role                                          |
| ------ | --------------------------------------------- |
| Docker | **builds** the image (`sandbox.sh base`)      |
| `msb`  | **runs** it as a microVM (`sandbox.sh run`)   |

`msb` keeps its **own** image store, separate from Docker — `sandbox.sh base`
bridges the two for you (`docker save … | msb load`). Verified on macOS /
Apple Silicon (arm64); the Dockerfile is multi-arch.

## Commands

```sh
./sandbox.sh base [docker-build-args...]   # rebuild from scratch, report versions, load into msb
./sandbox.sh run  [flags] [-- cmd...]      # run cmd in a fresh microVM (no cmd → interactive shell)
./sandbox.sh versions                      # print the tool versions in the current image
./sandbox.sh help
```

- **`base`** does a `--no-cache --pull` build (every tool is redownloaded so the
  image is reproducible from the pinned versions), then loads it into `msb` and
  boots a throwaway VM to print the versions that actually landed. Extra args pass
  straight to `docker build` (e.g. `./sandbox.sh base --build-arg GLAB_VERSION=1.103.0`).
- **`run`** boots an **ephemeral** VM (auto-removed on exit) as the unprivileged
  `gene` user with 2G RAM. `-n`/`-k`/`-d` keep it around.

Under the hood: `docker build` → `docker save REF | msb load -t REF` →
`msb run --pull never REF`. `--pull never` is required because the image is loaded
locally, not from a registry.

## `run` flags

| flag                  | meaning                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `-i`, `--inherit`     | bring your host tool auth/identity into the VM (see below) — implies `--internal` |
| `--internal`          | reach private/internal hosts (RFC1918, Tailscale subnet routes)           |
| `--isolated`          | force public-egress-only, even with `--inherit`                           |
| `-n`, `--name NAME`   | name the VM (named VMs are kept, not auto-removed)                         |
| `-k`, `--keep`        | keep the VM after the command exits                                       |
| `-d`, `--detach`      | start in the background and print the name                                |
| `-v`, `--volume SPEC` | mount `host:guest[:opts]` (repeatable; read-write unless `:ro`)           |
| `--pwd`               | mount the current dir at `/workspace/<basename>` and make it the workdir  |
| `-w`, `--workdir DIR` | working directory inside the VM (default `/workspace`)                    |
| `-c`, `--cpus N`      | number of vCPUs                                                           |
| `-m`, `--memory SIZE` | memory, e.g. `4G` (default `2G`)                                           |
| `-u`, `--user USER`   | run as this guest user (default `gene`)                                    |

### `--inherit` — host identity in the VM

A bare `run` is anonymous and isolated. `--inherit` wires your host credentials
into it so `claude`, `gh`, `glab`, `linear`, and `ntn` are logged in:

- **Config mounts** — each of these is bind-mounted if it exists on the host
  (read-write by default):
  `~/.claude`, `~/.config/{gh,glab-cli,glab,linear,notion}`.
- **Env proxy** — these are forwarded **when set** (only names are ever printed,
  never values): `ANTHROPIC_API_KEY`, `HUGGINGFACE_TOKEN`, `GITHUB_TOKEN`,
  `NPM_TOKEN`, `GITLAB_TOKEN`, `GITLAB_HOST`, `OPENAI_TOKEN`, `NOTION_API_TOKEN`,
  plus anything matching `CLAUDE_*`, `OPENAI_*`, `CODEX_*`, `NOTION_*`.
- **macOS Keychain bridge** — macOS keeps the Claude Code login in the Keychain,
  not on disk, so the `~/.claude` mount alone won't carry it. On macOS, `--inherit`
  copies the Keychain blob into a `0600 ~/.claude/.credentials.json` (where the
  Linux `claude` reads it) just before the run, then **removes it afterward**.
  `GENE_SANDBOX_KEEP_CREDENTIALS=1` keeps it; `GENE_SANDBOX_NO_KEYCHAIN=1` skips
  the bridge. A pre-existing file is left untouched.
- **Folder trust** — `claude -p` blocks on a "Do you trust this folder?" dialog the
  first time it runs in a directory. `--inherit` stages a **copy** of `~/.claude.json`
  with the workdir marked `hasTrustDialogAccepted=true` and mounts *that* (not the
  live file), so the VM is pre-trusted **and** can't write its own state back into
  your real `~/.claude.json`. Add more trusted dirs with
  `GENE_SANDBOX_TRUST_DIRS="dir1 dir2"` (e.g. worktree paths under `/workspace`).
- **Auto `--internal`** — authed work usually targets internal hosts (e.g. an
  on-prem GitLab over Tailscale), so `--inherit` turns on internal networking too;
  pass `--isolated` to keep public-egress-only.

> ⚠️ Mounts are **read-write** — the VM can modify your real credentials. Set
> `GENE_SANDBOX_INHERIT_RO=1` to mount everything read-only instead.

### Networking — `--internal` / `--isolated`

`msb`'s default egress is **deny-all-but-public**, and it drops DNS answers that
resolve to private IPs (rebind protection). So a bare `run` can reach the public
internet but **not** internal names like `gitlab.datacrunch.io` (a `10.x` address
reached via a Tailscale subnet route) — those fail to both resolve and connect.

`--internal` lifts both restrictions (`--net-default-egress allow
--no-dns-rebind-protection`), letting the VM reach whatever the host can, including
Tailscale. No nameserver config is needed — `msb`'s DNS forwarder already uses the
host resolver. (`GENE_SANDBOX_INTERNAL=1` makes it the default; `--inherit` enables
it automatically; `--isolated` forces public-only.)

### `--pwd` — run inside your repo

Mounts the host's current directory at `/workspace/<basename>` (deliberately **not**
at `/workspace`, so the repo keeps its name) and makes it the workdir unless `-w`
says otherwise. With `--inherit`, that exact dir is the one pre-trusted for `claude`.

```sh
./sandbox.sh run --pwd -- bash -lc 'npm test'              # mount cwd, cd into it, test
./sandbox.sh run --pwd --inherit -- claude -p 'fix the failing test'
```

## Included tools

Run `./sandbox.sh versions` for the live truth. As built (Ubuntu 24.04 base):

| tool     | source                              | version                          |
| -------- | ----------------------------------- | -------------------------------- |
| `node`   | NodeSource (`NODE_MAJOR=24`)        | 24.x                             |
| `npm`    | bundled with Node                   | 11.x                             |
| `git`    | apt                                 | 2.43.x                           |
| `gh`     | GitHub apt repo                     | latest                           |
| `glab`   | release binary (`GLAB_VERSION`)     | **pinned** 1.102.0               |
| `linear` | npm `@schpet/linear-cli`            | latest                           |
| `claude` | native installer (`CLAUDE_VERSION`) | **pinned** 2.1.168               |
| `ntn`    | native installer (`NTN_VERSION`)    | latest                           |

Pinned tools (`glab`, `claude`) are reproducible; the rest track their upstream at
build time. Override the pins with `--build-arg`, e.g.
`./sandbox.sh base --build-arg CLAUDE_VERSION=2.1.200`.

Baked runtime env (keeps long-lived agent connections resilient, pins `claude` to
its built-in version, and uses file-based auth since the microVM has no keyring):
`CLAUDE_CODE_REMOTE_SEND_KEEPALIVES=true`, `BUN_CONFIG_HTTP_IDLE_TIMEOUT=300`,
`BUN_CONFIG_HTTP_RETRY_COUNT=3`, `NODE_OPTIONS=--dns-result-order=ipv4first`,
`DISABLE_AUTOUPDATER=1`, `NOTION_KEYRING=0`.

## Non-root by design

The image runs as `gene` (uid/gid 1000, `HOME=/home/gene`) — it replaces Ubuntu's
stock `ubuntu` user to claim uid 1000. `claude` and `ntn` install under
`/home/gene/.local` (symlinked onto the system `PATH`) so they're reachable by the
unprivileged user. The agents the daemon spawns are never root.

## Environment overrides

All optional; flags take precedence where they overlap.

| variable                        | effect                                                       |
| ------------------------------- | ------------------------------------------------------------ |
| `GENE_SANDBOX_IMAGE` / `_TAG`   | image name / tag (default `geneai-sandbox-base:latest`)      |
| `GENE_SANDBOX_DOCKERFILE`       | Dockerfile path (default `./Dockerfile` next to the script)  |
| `GENE_SANDBOX_CONTEXT`          | build context (default the `sandbox/` dir)                   |
| `GENE_SANDBOX_VOLUME`           | a default `-v` mount                                         |
| `GENE_SANDBOX_WORKDIR`          | default workdir                                              |
| `GENE_SANDBOX_CPUS` / `_MEMORY` | default vCPUs / memory (`_MEMORY` default `2G`)              |
| `GENE_SANDBOX_USER` / `_HOME`   | guest user / home (default `gene` / `/home/gene`)            |
| `GENE_SANDBOX_INHERIT`          | `=1` to always `--inherit`                                   |
| `GENE_SANDBOX_INHERIT_RO`       | `=1` to mount inherited config read-only                     |
| `GENE_SANDBOX_INTERNAL`         | `=1` to always allow internal/private network access         |
| `GENE_SANDBOX_TRUST_DIRS`       | space-separated extra guest dirs to pre-trust for `claude`   |
| `GENE_SANDBOX_KEEP_CREDENTIALS` | `=1` keep the bridged `claude` creds file on the host        |
| `GENE_SANDBOX_NO_KEYCHAIN`      | `=1` skip the macOS Keychain → `credentials.json` bridge     |

## Examples

```sh
./sandbox.sh base                                          # build + load + report versions
./sandbox.sh run                                           # interactive shell (gene, 2G, isolated)
./sandbox.sh run claude --version
./sandbox.sh run --inherit -- claude -p 'summarize the open Linear issues'
./sandbox.sh run --internal -- glab -R group/repo mr list  # internal GitLab over Tailscale
./sandbox.sh run --inherit --isolated -- claude --version  # creds, but no internal network
./sandbox.sh run --pwd --inherit -- claude -p 'fix the failing test'
GENE_SANDBOX_INHERIT_RO=1 ./sandbox.sh run --inherit       # read-only host auth
./sandbox.sh run -d -n gene-bg -- bash -lc 'long job'      # detached; attach: msb exec gene-bg -- bash -l
```

## Notes & limits

- **`base` is a full rebuild** (`--no-cache --pull`) — it redownloads every tool, so
  it's slow but reproducible. There's no incremental build target by design.
- **Inherited mounts are live and read-write** unless `GENE_SANDBOX_INHERIT_RO=1` —
  a misbehaving agent can alter your real `~/.claude`, `gh`, or `glab` config.
- **`-u` doesn't change `HOME`** — `msb` keeps the image's `ENV HOME` regardless of
  the run user, so the script always passes `-e HOME=…` explicitly. If you override
  `--user`, per-user config may resolve under the wrong home.
- **Ephemeral by default** — a `run` VM is stopped and removed on exit (and so is the
  staged credentials/trust copy). Use `-k`, `-n`, or `-d` to keep one alive.
- **`msb` ≠ Docker store** — building with Docker alone isn't enough; `sandbox.sh`
  loads the image into `msb`. If you `docker build` by hand, run
  `docker save REF | msb load -t REF` before `msb run`.

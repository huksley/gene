#!/usr/bin/env bash
#
# One command to run the OpenTUI dashboard with its database: start Postgres in
# the background, then run the UI in the FOREGROUND so it owns the real terminal.
#
# Why not `concurrently` (what `npm run start:ui` used to do)? concurrently pipes
# every child's stdio so it can prefix and multiplex their logs — which means the
# UI child never gets a TTY: stdout isn't a terminal (OpenTUI's renderer falls
# back to a tiny default size — the "small window") and stdin isn't a raw TTY (so
# keypresses never arrive). A full-screen TUI has to be the sole foreground owner
# of the terminal, so it can't share one with a log multiplexer.
#
# Instead: background pg, wait until it accepts connections, run the UI in the
# foreground, and stop the pg we started once the UI exits. If a Postgres is
# already listening (e.g. `npm run pg` in another window) we reuse it untouched.
#
# Focus/flags pass through, e.g. `npm run start:ui -- linear:CLOUD-1094`.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
echo "UI mode requires Node 26.3.0 or later."

# The server always listens on whatever pg.conf says; default to 5434 (its value
# and db.ts's default). Used only for the readiness probe — the UI's client
# config (.env.development / db.ts defaults) is left to decide its own port.
host="127.0.0.1"
port="$(grep -E '^[[:space:]]*port[[:space:]]*=' pg.conf 2>/dev/null | grep -Eo '[0-9]+' | head -1)"
port="${port:-5434}"

# First-run bootstrap (mirrors the `prepg` npm script).
if [ ! -d data/pg ]; then
  mkdir -p data/pg
  initdb -D data/pg
fi

pg_pid=""
cleanup() {
  if [ -n "$pg_pid" ] && kill -0 "$pg_pid" 2>/dev/null; then
    echo "Stopping Postgres (pid $pg_pid)…"
    kill -INT "$pg_pid" 2>/dev/null || true   # SIGINT = fast shutdown
    wait "$pg_pid" 2>/dev/null || true
  fi
}

if pg_isready -q -h "$host" -p "$port"; then
  echo "Postgres already up on $host:$port — reusing it (leaving it running)."
else
  echo "Starting Postgres on $host:$port (log: data/pg/server.log)…"
  postgres -D data/pg --config-file=pg.conf >data/pg/server.log 2>&1 &
  pg_pid=$!
  trap cleanup EXIT
  # Wait up to ~15s for it to accept connections.
  for _ in $(seq 1 150); do
    if pg_isready -q -h "$host" -p "$port"; then
      break
    fi
    if ! kill -0 "$pg_pid" 2>/dev/null; then
      echo "Postgres exited during startup — see data/pg/server.log" >&2
      exit 1
    fi
    sleep 0.1
  done
  if ! pg_isready -q -h "$host" -p "$port"; then
    echo "Postgres did not become ready in time — see data/pg/server.log" >&2
    exit 1
  fi
fi

# Foreground, no `exec`, so the EXIT trap still runs to stop pg afterwards.
npm run ui -- "$@"

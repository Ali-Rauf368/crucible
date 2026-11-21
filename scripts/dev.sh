#!/usr/bin/env bash
# One command: project-local PostgreSQL (:55435) → API + proxy + workers (:4200) → web (:3200).
# Uses DATABASE_URL / REDIS_URL / MONGO_URL / ANTHROPIC_API_KEY from apps/api/.env when present.
# Ports already in use? Stop the other instance first (or change the *_PORT values below).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; LOCAL="$ROOT/.local"; mkdir -p "$LOCAL"
PG_PORT=55435 API_PORT=4200 WEB_PORT=3200
say() { printf '\033[1;36m[crucible]\033[0m %s\n' "$*"; }
listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
[ -f "$ROOT/apps/api/.env" ] && { set -a; . "$ROOT/apps/api/.env"; set +a; }
[ -d "$ROOT/node_modules" ] || { say "installing dependencies…"; (cd "$ROOT" && npm install --no-audit --no-fund); }

if [ -z "${DATABASE_URL:-}" ]; then
  PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "$PG_BIN" ] || { echo "PostgreSQL not found: install postgresql or set DATABASE_URL in apps/api/.env"; exit 1; }
  if ! listening $PG_PORT; then
    if [ ! -d "$LOCAL/pg" ]; then say "creating local PostgreSQL cluster…"; "$PG_BIN/initdb" -D "$LOCAL/pg" -U crucible --auth=trust >/dev/null; NEW=1; fi
    "$PG_BIN/pg_ctl" -D "$LOCAL/pg" -o "-p $PG_PORT -k $LOCAL -c listen_addresses=127.0.0.1" -l "$LOCAL/pg.log" start >/dev/null
    for _ in $(seq 30); do listening $PG_PORT && break; sleep 0.5; done
    [ "${NEW:-0}" = 1 ] && psql -h 127.0.0.1 -p $PG_PORT -U crucible -d postgres -qc "create database crucible" >/dev/null && psql -h 127.0.0.1 -p $PG_PORT -U crucible -d postgres -qc "create database crucible_test" >/dev/null
  fi
  export DATABASE_URL="postgresql://crucible@127.0.0.1:$PG_PORT/crucible"
fi
export PORT=$API_PORT WEB_ORIGIN="http://localhost:$WEB_PORT" NEXT_PUBLIC_API_URL="http://localhost:$API_PORT" API_URL="http://127.0.0.1:$API_PORT" PUBLIC_URL="${PUBLIC_URL:-http://127.0.0.1:$API_PORT}"

say "open http://localhost:$WEB_PORT   ·   engineer@crucible.dev / crucible-demo"
say "judge: ${ANTHROPIC_API_KEY:+Claude (${ANTHROPIC_MODEL:-claude-opus-5-5})}${ANTHROPIC_API_KEY:-heuristic (set ANTHROPIC_API_KEY in apps/api/.env for an LLM judge)}  ·  traces: ${MONGO_URL:+MongoDB}${MONGO_URL:-PostgreSQL}  ·  queue: ${REDIS_URL:+BullMQ/Redis}${REDIS_URL:-PostgreSQL}"
cd "$ROOT"
exec npx concurrently -k -n api,web -c cyan,magenta \
  "npm -w apps/api run dev" \
  "bash -c 'until (exec 3<>/dev/tcp/127.0.0.1/$API_PORT) 2>/dev/null; do sleep 1; done; exec npm -w apps/web run dev'"

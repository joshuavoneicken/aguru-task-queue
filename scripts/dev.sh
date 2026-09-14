#!/usr/bin/env bash
set -euo pipefail

# Local run: Postgres, migrations, the API, and one worker. When the UI has been
# built (ui/dist), the API serves it, so the dashboard and the API share one
# origin — there is no separate UI port in this mode.

cd "$(dirname "$0")/.."

# Load .env when present (the Node processes read it too); otherwise fall back to
# local defaults. This keeps docker compose, the migrator, and the banner below
# all reading the same connection settings.
if [ -f .env ]; then
  set -a; . ./.env; set +a
else
  export DATABASE_URL="${DATABASE_URL:-postgres://queue:queue@localhost:${POSTGRES_PORT:-5432}/queue}"
  export QUEUES_FILE="${QUEUES_FILE:-queues.json}"
fi

api_port="${PORT:-3000}"
pg_port="${POSTGRES_PORT:-5432}"

docker compose up -d --wait
npm run migrate

# API and worker share this process group; Ctrl-C stops both.
trap 'kill 0' INT TERM

npm run dev:api &
sleep 1  # let the API bind before the worker starts claiming over HTTP

queue_name="${QUEUE_NAME:-jobs}"

printf '\n  Aguru Task Queue\n'
printf '  ─────────────────────────────────────────────\n'
printf '  API and dashboard   http://localhost:%s\n' "$api_port"
printf '  Postgres            localhost:%s\n' "$pg_port"
printf '  Worker              one, on queue "%s"\n' "$queue_name"
printf '  ─────────────────────────────────────────────\n\n'

npm run dev:worker &
wait

#!/usr/bin/env bash
# End-to-end Bruno run against a throwaway, freshly-seeded database.
#
# Why a separate DB: the suite has a write path (06-08) and only logs out at
# teardown, so rows it creates would otherwise pile up in the dev DB and a later
# run would read them (that's how the newest post ends up tag-less and breaks
# 03-posts-read). We point the run at ./data/test.db, rebuild it from the
# deterministic seed (fixed faker.seed → byte-identical every run), and never
# touch the dev DB at ./data/app.db.
set -euo pipefail

cd "$(dirname "$0")/.."

export DB_PATH="./data/test.db"
export SIM_ENABLED=false   # firehose off so bot writes can't perturb count assertions
export CSRF_ENABLED=true   # 02-auth/csrf-reject asserts a 403, which needs CSRF on

# Fresh schema + deterministic seed on the throwaway DB.
rm -f "$DB_PATH"
bun run db:migrate
bun run db:seed

# Boot the API and guarantee it's torn down however this script exits.
bun run src/index.ts &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

# Wait for the server to answer before unleashing the suite (~max 10s).
for _ in $(seq 1 50); do
  if curl -sf http://localhost:3000/health >/dev/null 2>&1; then break; fi
  sleep 0.2
done

# REST surface: the full Bruno suite (it self-cleans its writes in 99-teardown).
(cd bruno && bru run --env local --disable-cookies)

# What Bruno can't reach: WebSockets + the firehose. These assert live events on
# the wire and exit non-zero on the first failure, so `set -e` fails the run.
# Run after Bruno so their (un-pruned) writes can't perturb its count assertions;
# the next run reseeds from scratch anyway, so the residue never leaks across runs.
bun run scripts/ws-smoke.ts
bun run scripts/sim-smoke.ts

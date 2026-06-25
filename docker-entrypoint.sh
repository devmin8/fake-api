#!/bin/sh
# Container entrypoint. The server applies migrations on boot, so the only thing
# we handle here is opt-in seeding: the seed WIPES every table, so we never run it
# automatically on a volume that may hold real data. Set SEED_ON_START=true to get
# demo data (and the bot users the firehose drives) on a fresh DB.
set -e

if [ "${SEED_ON_START}" = "true" ]; then
  echo "→ SEED_ON_START=true: applying migrations + seeding (this WIPES the database)…"
  bun run src/db/migrate.ts
  bun run src/db/seed.ts
fi

exec "$@"

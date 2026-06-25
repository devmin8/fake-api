# fake-api container. Bun runs the TypeScript directly — no build/transpile step.
# Migrations apply on boot (runMigrations in src/index.ts), so a fresh volume
# comes up fully-tabled. Seeding is opt-in (SEED_ON_START=true) because the seed
# is destructive — see docker-entrypoint.sh.

FROM oven/bun:1 AS deps
WORKDIR /app
# Install with the lockfile only first, so this layer caches across source edits.
# All deps (incl. @faker-js/faker) — the seed needs faker at runtime.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS release
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/app.db \
    UPLOAD_DIR=/data/uploads

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Persist the SQLite db + uploaded media across container restarts.
VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]

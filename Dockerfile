# fake-api container. Bun runs the TypeScript directly — no build/transpile step.
# Migrations apply on boot (runMigrations in src/index.ts), so a fresh volume
# comes up fully-tabled. Seeding is opt-in (SEED_ON_START=true) because the seed
# is destructive — see docker-entrypoint.sh.

FROM oven/bun:1 AS deps
WORKDIR /app
# Install with the lockfile only first, so this layer caches across source edits.
# Production deps only: this drops drizzle-kit (a dev-time codegen tool that bundles
# a vulnerable Go `esbuild` binary the runtime never uses). Migrations run via
# drizzle-orm and the seed uses faker — both are runtime `dependencies`.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1 AS release
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/app.db \
    UPLOAD_DIR=/data/uploads

# Pull the latest Debian security patches for base-image OS packages (openssl,
# libcap, …) so the image isn't shipping known-fixed CVEs. Runs as root before
# we drop to the `bun` user below.
RUN apt-get update \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Run as the unprivileged `bun` user that ships with the image instead of root,
# so a compromised process isn't root inside the container. /data is the writable
# volume (SQLite + uploads), so it must be owned by `bun` before we drop privileges;
# a fresh volume inherits this ownership from the image.
RUN mkdir -p /data/uploads && chown -R bun:bun /data
USER bun

# Persist the SQLite db + uploaded media across container restarts.
VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]

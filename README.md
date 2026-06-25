# fake-api

A self-hosted, fully relational, **real-time mock backend** — a permanent practice ground for
building any frontend against real auth, real data, and a live event stream. Unlike
JSONPlaceholder & friends, it **accepts writes, enforces auth, models relationships, and
streams a live feed over WebSockets** — and ships a **firehose simulator** so the feed is alive
the moment you open it, with no second client.

**Stack:** Bun · Elysia · Drizzle · bun:sqlite · native WebSockets · cookie-JWT auth (refresh
rotation + CSRF double-submit). Full spec: [`.docs/system-design.html`](.docs/system-design.html).

## Quick start

```bash
bun install
bun run db:migrate && bun run db:seed     # create + seed ./data/app.db (users, bots, posts…)
bun run dev                               # REST + ws://…/ws on $PORT · firehose auto-on · Swagger at /docs
```

Or with Docker (`SEED_ON_START=true` seeds demo data + bots on first boot):

```bash
docker run -p 3000:3000 -e SEED_ON_START=true -v fake-api-data:/data ghcr.io/devmin8/fake-api:latest
```

### Public HTTPS URL with [portless](https://portless.sh)

Get a real `https://` URL (handy for OAuth callbacks, mobile testing, or sharing) instead of
`localhost:3000`. portless wraps the process, auto-detects its port, and serves it at
`https://fake-api.localhost` (name inferred from `package.json`):

```bash
portless run bun dev                  # wraps `bun run dev`; URL → https://fake-api.localhost
```

For the Docker image, portless can't auto-detect the port (Docker's proxy opens the socket, not
the wrapped process) — publish the port with `-p` and pin it with `--app-port`:

```bash
portless run --app-port 3000 \
  docker run --rm -p 3000:3000 -e SEED_ON_START=true -v fake-api-data:/data \
  ghcr.io/devmin8/fake-api:latest
```

Serving a frontend through portless too? Point its API calls at `https://fake-api.localhost` and
set `CORS_ORIGIN` to that frontend's portless URL so cross-origin requests + auth cookies work.

## API at a glance

Reads are public; writes need a session (🔒). Browse signed-out, write signed-in.
**Interactive docs + every schema live at [`/docs`](http://localhost:3000/docs).**

| Area | Endpoints |
|---|---|
| **Auth** | `POST /api/auth/register · login · refresh · logout` · 🔒 `GET /api/auth/me` |
| **Posts** | `GET /api/posts` *(sort=`new`\|`top`\|`trending`, `cursor`, `tag`, `author`)* · `GET /api/posts/:id` · `GET /api/posts/updates?since=` · 🔒 `POST /api/posts` · 🔒 `PATCH·DELETE /api/posts/:id` |
| **Comments** | `GET /api/posts/:id/comments` · `GET /api/comments/:id/replies` · 🔒 `POST /api/posts/:id/comments` · 🔒 `DELETE /api/comments/:id` |
| **Likes** | 🔒 `POST·DELETE /api/posts/:id/like` · 🔒 `POST·DELETE /api/comments/:id/like` |
| **Users & social** | `GET /api/users/:username` *(+ `/posts` `/followers` `/following`)* · 🔒 `PATCH /api/users/me` · 🔒 `POST·DELETE /api/users/:username/follow` |
| **Tags** | `GET /api/tags` · `GET /api/tags/:slug/posts` |
| **Feed & bookmarks** | 🔒 `GET /api/feed` *(posts from people you follow)* · 🔒 `GET /api/bookmarks` · 🔒 `POST·DELETE /api/posts/:id/bookmark` |
| **Notifications** | 🔒 `GET /api/notifications` · 🔒 `POST /api/notifications/read-all` · 🔒 `POST /api/notifications/:id/read` |
| **Media** | 🔒 `POST /api/media` *(multipart)* · `GET /api/media/:file` |
| **Realtime** | `WS /ws` — subscribe to topics, receive `{ topic, event, data, ts }` |
| **Simulator** | `GET /api/sim/status` · `POST /api/sim/start · /stop` · `PATCH /api/sim/config` |

**Reads are cursor-paginated, not offset** — every list returns `{ data, nextCursor, … }`. Pass
`cursor` + `dir=older` to scroll back; `dir=newer` (or `GET /api/posts/updates?since=`) fetches
only what arrived since your head cursor. Head inserts never shift a page you're paging through.

## Realtime

The endpoint is `ws://<host>/ws`. Subscribe, then the server pushes `{ topic, event, data, ts }`:

```jsonc
// client → server
{ "action": "subscribe", "topic": "feed:global" }
// server → client
{ "topic": "feed:global", "event": "post.created", "data": { /* the post */ }, "ts": "…" }
```

| Topic | Carries | Access |
|---|---|---|
| `feed:global` | `post.created` | public |
| `tag:{slug}` | `post.created` for that tag | public |
| `post:{id}` | `post.liked/unliked/viewed`, `comment.created/liked` | public |
| `user:{id}` | your notifications | 🔒 owner only (access-token cookie at upgrade) |

## Firehose simulator

Bot users (`is_bot`) that post / comment / like / follow on a timer, driving the **same
`src/services/` write path real requests use** — so the feed streams with **zero authenticated
clients** and simulated data is byte-identical to real data (same rows, same WS events).

Auto-starts when `SIM_ENABLED=true` (default). Toggle and tune it live via `/api/sim`
(gated by `SIM_CONTROL_ENABLED`):

```bash
curl localhost:3000/api/sim/status                       # running state + config
curl -X POST localhost:3000/api/sim/start                # start  (idempotent)
curl -X POST localhost:3000/api/sim/stop                 # stop   (idempotent)
curl -X PATCH localhost:3000/api/sim/config \            # tune cadence / weights live
  -H 'content-type: application/json' \
  -d '{"intervalMs":2000,"actionsPerTick":3,"weights":{"createPost":50}}'
```

Knobs (env or `PATCH /api/sim/config`): `SIM_INTERVAL_MS` (default **10000**),
`SIM_ACTIONS_PER_TICK` (default 1), and the action weights — create post 20% · comment 35% ·
like post 30% · like-comment/follow 15%.

**See the whole thesis in 30 seconds:** open a WebSocket to `ws://localhost:3000/ws` (no login),
send `{"action":"subscribe","topic":"feed:global"}`, and watch `post.created` / `comment.created`
/ `post.liked` stream in while rows land in `data/app.db` — no authenticated client anywhere.
`scripts/sim-smoke.ts` automates exactly this proof.

### Leaving it running — and the one limitation

There's **no auto-pruning**: the firehose only ever adds rows, by design. At the default 10s
cadence that's **~360 actions/hour** ≈ **72 posts · 126 comments**, the rest likes/follows/
notifications. So:

- **A 10-hour session is a non-issue** — under ~1k posts and a few-thousand rows total. SQLite
  does *millions*; the `app.db` file grows a few MB and read latency is unchanged.
- **Only an always-on box (days→weeks)** accumulates enough to matter (and `ORDER BY RANDOM()`
  in the bot pickers slowly costs more). The fix is deliberately manual: **`bun run db:seed`**
  wipes and reseeds back to a clean baseline. No background reaper — fewer moving parts.

It's safe to leave streaming overnight; just reseed if you run it for days.

## Good to know

- **Auth** is cookie-based (access + refresh + CSRF). CSRF is gated by `CSRF_ENABLED` (default
  on) — flip it off while learning a frontend to skip the double-submit header dance.
- **Testing:** start the server with `bun run dev:test` (firehose off → deterministic counts),
  then `cd bruno && bru run --env local --disable-cookies`. WebSockets aren't Bruno-testable —
  `scripts/ws-smoke.ts` and `scripts/sim-smoke.ts` cover the realtime + firehose paths.
- **Data lives in `./data`** (`DB_PATH`, `UPLOAD_DIR`) — the Docker volume mount point.

## Project notes

Built ticket-by-ticket; the build is feature-complete per the system design.
Workflow, backlog, and conventions: [`.docs/workflow.html`](.docs/workflow.html) ·
[`.docs/tasks/`](.docs/tasks/) · [`CLAUDE.md`](CLAUDE.md) (agent instructions).

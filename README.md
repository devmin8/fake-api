# fake-api

A self-hosted, fully relational, real-time **mock backend** — a permanent practice ground for
building any frontend against real auth, real data, and a live event stream. Unlike
JSONPlaceholder & friends, it accepts writes, enforces auth, models relationships, and
streams a live feed over WebSockets.

## Stack

**Bun** · **Elysia** · **Drizzle** · **bun:sqlite** · native **WebSockets** · cookie-JWT auth
(+ refresh rotation, CSRF double-submit). Full spec: [`.docs/system-design.html`](.docs/system-design.html).

## What it does

- Social/Q&A feed domain — users, posts (with images), threaded comments, likes, tags,
  follows, bookmarks, notifications.
- Public/authenticated route split (browse signed-out; write signed-in).
- Cursor-paginated, filterable, sortable reads over genuinely relational data.
- WebSocket topics for live counts, new posts, comments, and per-user notifications.
- A toggleable **firehose simulator** — bot users that post/comment/like on a timer, so the
  feed visibly streams with no second client.

## Status

Built ticket-by-ticket. The current task is whatever
[`.docs/tasks/status.html`](.docs/tasks/status.html) points to under **Next**.

## Quick start (once code exists)

```bash
bun install
bun run db:migrate && bun run db:seed
bun run dev                          # API on $PORT (REST + ws://…/ws) — firehose auto-on

# To run the test suite, start the server with the firehose OFF (deterministic
# counts), then run Bruno against it from another terminal:
bun run dev:test                     # same server, SIM_ENABLED=false
cd bruno && bru run --env local --disable-cookies   # the API test suite (server must be up)

bun run scripts/ws-smoke.ts          # realtime check (server must be running)
bun run scripts/sim-smoke.ts         # firehose streaming proof (server must be running)
```

Swagger lives at `/docs`. The realtime endpoint is `ws://<host>/ws`: subscribe with
`{ "action": "subscribe", "topic": "feed:global" }` and the server pushes
`{ topic, event, data, ts }` envelopes. Public topics (`feed:global`, `tag:{slug}`,
`post:{id}`) are open; `user:{id}` requires the access-token cookie at upgrade and only
the owner may subscribe.

## Firehose simulator

Bot users (`is_bot`) that post / comment / like / follow on a timer, driving the **same**
`src/services/` write path real requests use — so the feed streams with **zero** authenticated
clients and simulated data is indistinguishable from real data (same rows, same WS events).

It auto-starts when `SIM_ENABLED=true` (the default). A control surface under `/api/sim`
(gated by `SIM_CONTROL_ENABLED`) toggles and tunes it live:

```bash
curl localhost:3000/api/sim/status                       # running state + config
curl -X POST localhost:3000/api/sim/start                # start (idempotent)
curl -X POST localhost:3000/api/sim/stop                 # stop  (idempotent)
curl -X PATCH localhost:3000/api/sim/config \            # tune cadence / weights live
  -H 'content-type: application/json' \
  -d '{"intervalMs":1000,"actionsPerTick":3,"weights":{"createPost":50}}'
```

Tuning knobs (env or `PATCH /api/sim/config`): `SIM_INTERVAL_MS` (tick cadence),
`SIM_ACTIONS_PER_TICK`, and the action weights (create post · comment · like post ·
like-comment/follow).

**See the whole thesis in 30 seconds:**

1. `bun run db:seed && bun run dev` (the seed creates the bot users the sim acts as).
2. Open `/docs` and, in a separate tab, open a WebSocket to `ws://localhost:3000/ws` (any WS
   client — no login needed) and send `{ "action": "subscribe", "topic": "feed:global" }`.
3. `curl -X POST localhost:3000/api/sim/start` (or just leave `SIM_ENABLED=true`).
4. Watch `post.created` / `comment.created` / `post.liked` envelopes stream onto the socket,
   and the new rows land in `data/app.db` — with no authenticated client anywhere.

`scripts/sim-smoke.ts` automates exactly this proof (anonymous socket → start sim → assert a
`post.created` arrives → stop). When running the Bruno suite, start the server with
`bun run dev:test` (which sets `SIM_ENABLED=false`) so the firehose doesn't perturb the
read/count assertions in other folders — the `10-sim/` folder drives start/stop explicitly.

## Working on it

- **Workflow:** [`.docs/workflow.html`](.docs/workflow.html) — one ticket at a time, each
  commit working and incremental.
- **Tasks:** [`.docs/tasks/backlog/`](.docs/tasks/backlog/) (`done/` is history).
- **Testing:** Bruno, one folder per resource under `bruno/`, per
  [`.docs/tasks/bruno-testing-plan.html`](.docs/tasks/bruno-testing-plan.html). No unit tests.
  WebSockets aren't Bruno-testable — `scripts/ws-smoke.ts` and `scripts/sim-smoke.ts` cover
  the realtime and firehose paths instead.
- For agents: see [`CLAUDE.md`](CLAUDE.md).

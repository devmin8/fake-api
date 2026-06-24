# MockStack API

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
bun run dev                          # API on $PORT
cd bruno && bru run --env local      # run the API test suite
```

Swagger lives at `/docs`.

## Working on it

- **Workflow:** [`.docs/workflow.html`](.docs/workflow.html) — one ticket at a time, each
  commit working and incremental.
- **Tasks:** [`.docs/tasks/backlog/`](.docs/tasks/backlog/) (`done/` is history).
- **Testing:** Bruno, one folder per resource under `bruno/`, per
  [`.docs/tasks/bruno-testing-plan.html`](.docs/tasks/bruno-testing-plan.html). No unit tests.
- For agents: see [`CLAUDE.md`](CLAUDE.md).

# fake-api — Claude working notes

A self-hosted relational + realtime mock backend. **Bun · Elysia · Drizzle · bun:sqlite ·
native WebSockets · cookie-JWT auth.** Full spec: [`.docs/system-design.html`](.docs/system-design.html).

## The workflow (one line)

> **"Work on the current task"** → open [`.docs/tasks/status.html`](.docs/tasks/status.html),
> do the ticket its **Next** pointer names, write that ticket's Bruno tests, move the ticket
> to `done/`, log one line + repoint **Next** in `status.html`, then **stop and wait for
> approval.**

Never skip ahead to the next ticket. One ticket in, one log line out, then pause.

## What to read, in order

1. [`.docs/tasks/status.html`](.docs/tasks/status.html) — the **Next** pointer = the only
   thing that says which ticket to do now.
2. The ticket it points to in [`.docs/tasks/backlog/`](.docs/tasks/backlog/).
3. [`.docs/tasks/bruno-testing-plan.html`](.docs/tasks/bruno-testing-plan.html) — **read
   before writing any Bruno test.** The cookie+CSRF auth pattern here is what keeps the suite
   green in the `bru` CLI.
4. [`.docs/workflow.html`](.docs/workflow.html) — the full pick-up/hand-off process.

## Rules

- **Each commit is working and incremental.** No commits that just add empty folders or
  `.gitkeep`. Don't split work so finely that a commit can't run.
- **No unit tests.** Test the API with **Bruno** as you build — one folder per resource under
  `bruno/`, following the testing plan. Run headless with
  `cd bruno && bru run --env local --disable-cookies`.
- **Services are the one write path.** Every state mutation lives in `src/services/`; routes
  are thin (validate → service → respond) and the firehose calls the same services. Simulated
  and real data must never diverge.
- **Handoff notes go in the ticket**, only when there's something the next agent must know.
  `status.html` gets one log line (+ `[notes]` flag if you left any).
- **Imports use the `~` alias for anything under `src/`.** `~` maps to `src/`
  (set in `tsconfig.json` `paths`). Write `import { config } from "~/config.ts"`,
  never relative hops like `../../config.ts`. Keep the `.ts` extension.
- **Import order** — three groups, one blank line between each:
  1. external library imports
  2. alias imports (`~/...`)
  3. same-folder imports (`./...`)
- **Stop after each ticket and wait for approval.**

## Quick commands (once code exists)

```bash
bun run dev                 # start the API
bun run db:migrate          # apply migrations
bun run db:seed             # seed users/bots/posts/comments/tags
cd bruno && bru run --env local --disable-cookies   # run the whole Bruno suite in order
```

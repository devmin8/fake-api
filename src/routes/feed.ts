// Feed route — the caller's personalized timeline. AUTH: a feed is meaningless
// without a session, so the whole thing sits behind the guard. Thin: clamp the
// query, delegate to the feed service.

import { Elysia, t } from "elysia";

import { listFeed } from "~/services/feed.ts";

import { authGuard } from "~/plugins/auth-guard.ts";

const clampLimit = (v?: number): number => {
  if (v === undefined || Number.isNaN(v)) return 20;
  return Math.max(1, Math.min(100, Math.floor(v)));
};

export const feedRoutes = new Elysia({ prefix: "/api/feed" })
  .use(authGuard)

  // AUTH — posts from the people you follow, newest-first, cursor paginated.
  .get(
    "/",
    ({ user, query }) =>
      listFeed(user!.id, {
        cursor: query.cursor,
        dir: query.dir ?? "older",
        limit: clampLimit(query.limit),
      }),
    {
      auth: true,
      query: t.Object({
        cursor: t.Optional(t.String()),
        dir: t.Optional(t.Union([t.Literal("older"), t.Literal("newer")])),
        limit: t.Optional(t.Numeric()),
      }),
      detail: { summary: "Your feed", tags: ["feed"] },
    },
  );

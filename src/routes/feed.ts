// Feed route — the caller's personalized timeline. AUTH: a feed is meaningless
// without a session, so the whole thing sits behind the guard. Thin: clamp the
// query, delegate to the feed service.

import { Elysia } from "elysia";

import { listParams, listQuery } from "~/lib/pagination.ts";

import { listFeed } from "~/services/feed.ts";

import { authGuard } from "~/plugins/auth-guard.ts";

export const feedRoutes = new Elysia({ prefix: "/api/feed" })
  .use(authGuard)

  // AUTH — posts from the people you follow, newest-first, cursor paginated.
  .get("/", ({ user, query }) => listFeed(user!.id, listParams(query)), {
    auth: true,
    query: listQuery,
    detail: { summary: "Your feed", tags: ["feed"] },
  });

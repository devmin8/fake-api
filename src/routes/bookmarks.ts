// Bookmarks route. The add/remove toggles live on the post (/api/posts/:id/
// bookmark); this is just the caller's own saved-posts list. AUTH throughout —
// a bookmark list is private to its owner. Thin: clamp the query, delegate to
// the bookmarks service.

import { Elysia, t } from "elysia";

import { listBookmarks } from "~/services/bookmarks.ts";

import { authGuard } from "~/plugins/auth-guard.ts";

const clampLimit = (v?: number): number => {
  if (v === undefined || Number.isNaN(v)) return 20;
  return Math.max(1, Math.min(100, Math.floor(v)));
};

export const bookmarkRoutes = new Elysia({ prefix: "/api/bookmarks" })
  .use(authGuard)

  // AUTH — the caller's bookmarked posts, newest-saved first, paginated.
  .get(
    "/",
    ({ user, query }) =>
      listBookmarks(user!.id, {
        cursor: query.cursor,
        limit: clampLimit(query.limit),
      }),
    {
      auth: true,
      query: t.Object({
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.Numeric()),
      }),
      detail: { summary: "List your bookmarks", tags: ["bookmarks"] },
    },
  );

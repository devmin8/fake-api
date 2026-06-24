// Post read routes — all public. Thin: parse/clamp the query, delegate to the
// posts service, return its result. The service owns every read so the firehose
// can reuse it. Writes land in task-008.

import { Elysia, t } from "elysia";

import { getPostById, listPosts, postUpdates } from "~/services/posts.ts";

// default 20, max 100, min 1 — non-numeric/absent falls back to the default.
const clampLimit = (v?: number): number => {
  if (v === undefined || Number.isNaN(v)) return 20;
  return Math.max(1, Math.min(100, Math.floor(v)));
};

const listQuery = t.Object({
  sort: t.Optional(
    t.Union([t.Literal("new"), t.Literal("top"), t.Literal("trending")]),
  ),
  tag: t.Optional(t.String()),
  author: t.Optional(t.String()),
  cursor: t.Optional(t.String()),
  dir: t.Optional(t.Union([t.Literal("older"), t.Literal("newer")])),
  limit: t.Optional(t.Numeric()),
});

export const postRoutes = new Elysia({ prefix: "/api/posts" })
  // PUBLIC — paginated/sortable/filterable list with the collection envelope.
  .get(
    "/",
    ({ query }) =>
      listPosts({
        sort: query.sort ?? "new",
        tag: query.tag,
        author: query.author,
        cursor: query.cursor,
        dir: query.dir ?? "older",
        limit: clampLimit(query.limit),
      }),
    { query: listQuery, detail: { summary: "List posts", tags: ["posts"] } },
  )

  // PUBLIC — head-check: how many posts are newer than `since`. Declared before
  // /:id so the static segment wins.
  .get("/updates", ({ query }) => postUpdates(query.since), {
    query: t.Object({ since: t.String() }),
    detail: { summary: "Newer-posts head-check", tags: ["posts"] },
  })

  // PUBLIC — detail; increments view_count.
  .get("/:id", ({ params }) => getPostById(params.id), {
    detail: { summary: "Post detail", tags: ["posts"] },
  });

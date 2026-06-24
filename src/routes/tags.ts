// Tag read routes — all public. Thin: parse/clamp the query, delegate to the
// tags service, return its result.

import { Elysia, t } from "elysia";

import { listTagPosts, listTags } from "~/services/tags.ts";

const clampLimit = (v?: number): number => {
  if (v === undefined || Number.isNaN(v)) return 20;
  return Math.max(1, Math.min(100, Math.floor(v)));
};

const listQuery = t.Object({
  cursor: t.Optional(t.String()),
  dir: t.Optional(t.Union([t.Literal("older"), t.Literal("newer")])),
  limit: t.Optional(t.Numeric()),
});

export const tagRoutes = new Elysia({ prefix: "/api/tags" })
  // PUBLIC — all tags with post counts.
  .get("/", () => listTags(), {
    detail: { summary: "List tags", tags: ["tags"] },
  })

  // PUBLIC — paginated posts in a tag.
  .get("/:slug/posts", ({ params, query }) =>
    listTagPosts(params.slug, {
      cursor: query.cursor,
      dir: query.dir ?? "older",
      limit: clampLimit(query.limit),
    }),
  {
    query: listQuery,
    detail: { summary: "Posts in tag", tags: ["tags"] },
  });

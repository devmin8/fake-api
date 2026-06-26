// Tag read routes — all public. Thin: parse/clamp the query, delegate to the
// tags service, return its result.

import { Elysia } from "elysia";

import { listParams, listQuery } from "~/lib/pagination.ts";

import { listTagPosts, listTags } from "~/services/tags.ts";

export const tagRoutes = new Elysia({ prefix: "/api/tags" })
  // PUBLIC — all tags with post counts.
  .get("/", () => listTags(), {
    detail: { summary: "List tags", tags: ["tags"] },
  })

  // PUBLIC — paginated posts in a tag.
  .get("/:slug/posts", ({ params, query }) =>
    listTagPosts(params.slug, listParams(query)),
  {
    query: listQuery,
    detail: { summary: "Posts in tag", tags: ["tags"] },
  });

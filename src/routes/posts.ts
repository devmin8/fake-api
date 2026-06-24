// Post routes. Reads are public; writes are AUTH (create) or OWNER (edit/delete,
// enforced inside the service). Thin throughout: validate the body/query,
// delegate to the posts service — the service owns every read and write so the
// firehose can reuse the exact same code path.

import { Elysia, t } from "elysia";

import {
  createPost,
  deletePost,
  getPostById,
  listPosts,
  postUpdates,
  updatePost,
} from "~/services/posts.ts";

import { authGuard } from "~/plugins/auth-guard.ts";

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

const createBody = t.Object({
  title: t.String({ minLength: 1, maxLength: 200 }),
  body: t.String({ minLength: 1, maxLength: 20000 }),
  imageUrl: t.Optional(t.String({ maxLength: 2000 })),
  tags: t.Optional(
    t.Array(t.String({ minLength: 1, maxLength: 50 }), { maxItems: 10 }),
  ),
});

// Every field optional — a PATCH may touch any subset. `tags` present (even [])
// replaces the tag set; omitted leaves it untouched. `imageUrl: null` clears it.
const updateBody = t.Object({
  title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
  body: t.Optional(t.String({ minLength: 1, maxLength: 20000 })),
  imageUrl: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])),
  tags: t.Optional(
    t.Array(t.String({ minLength: 1, maxLength: 50 }), { maxItems: 10 }),
  ),
});

export const postRoutes = new Elysia({ prefix: "/api/posts" })
  .use(authGuard)

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
  })

  // AUTH — create a post owned by the caller.
  .post(
    "/",
    ({ user, body, set }) => {
      set.status = 201;
      return createPost(user!.id, body);
    },
    { auth: true, body: createBody, detail: { summary: "Create post", tags: ["posts"] } },
  )

  // OWNER — edit; 403 for a non-owner, 404 for a missing post (in the service).
  .patch("/:id", ({ user, params, body }) => updatePost(params.id, user!.id, body), {
    auth: true,
    body: updateBody,
    detail: { summary: "Update post", tags: ["posts"] },
  })

  // OWNER — delete (cascades comments/likes/post_tags/bookmarks).
  .delete(
    "/:id",
    async ({ user, params }) => {
      await deletePost(params.id, user!.id);
      return { ok: true };
    },
    { auth: true, detail: { summary: "Delete post", tags: ["posts"] } },
  );

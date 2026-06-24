// Comment routes. Reads (list/replies) are public; create is AUTH, delete is
// OWNER (enforced inside the service). Thin: parse/clamp the query or validate
// the body, delegate to the comments service — the one read/write path the
// firehose reuses too.

import { Elysia, t } from "elysia";

import {
  createComment,
  deleteComment,
  listCommentReplies,
  listPostComments,
} from "~/services/comments.ts";
import { like, unlike } from "~/services/likes.ts";

import { authGuard } from "~/plugins/auth-guard.ts";

const clampLimit = (v?: number): number => {
  if (v === undefined || Number.isNaN(v)) return 20;
  return Math.max(1, Math.min(100, Math.floor(v)));
};

const listQuery = t.Object({
  cursor: t.Optional(t.String()),
  dir: t.Optional(t.Union([t.Literal("older"), t.Literal("newer")])),
  limit: t.Optional(t.Numeric()),
});

const createCommentBody = t.Object({
  body: t.String({ minLength: 1, maxLength: 10000 }),
  parentId: t.Optional(t.String()),
});

const listHandler =
  (fn: (id: string, params: { cursor?: string; dir: "older" | "newer"; limit: number }) => unknown) =>
  ({
    params,
    query,
  }: {
    params: { id: string };
    query: { cursor?: string; dir?: "older" | "newer"; limit?: number };
  }) =>
    fn(params.id, {
      cursor: query.cursor,
      dir: query.dir ?? "older",
      limit: clampLimit(query.limit),
    });

// Mount on postRoutes (inherits /api/posts prefix): GET + POST /:id/comments.
export const postCommentRoutes = new Elysia()
  .use(authGuard)
  .get("/:id/comments", listHandler(listPostComments), {
    query: listQuery,
    detail: { summary: "List top-level comments on a post", tags: ["comments"] },
  })

  // AUTH — comment on a post (optionally a threaded reply via parentId).
  .post(
    "/:id/comments",
    ({ user, params, body, set }) => {
      set.status = 201;
      return createComment(params.id, user!.id, body);
    },
    {
      auth: true,
      body: createCommentBody,
      detail: { summary: "Create comment", tags: ["comments"] },
    },
  );

export const commentRoutes = new Elysia({ prefix: "/api/comments" })
  .use(authGuard)
  .get("/:id/replies", listHandler(listCommentReplies), {
    query: listQuery,
    detail: { summary: "List replies under a comment", tags: ["comments"] },
  })

  // OWNER — delete (replies cascade; post.comment_count is decremented).
  .delete(
    "/:id",
    async ({ user, params }) => {
      await deleteComment(params.id, user!.id);
      return { ok: true };
    },
    { auth: true, detail: { summary: "Delete comment", tags: ["comments"] } },
  )

  // AUTH — like / unlike a comment. Idempotent toggles; both return the new count.
  .post(
    "/:id/like",
    ({ user, params }) => like(user!.id, "comment", params.id),
    { auth: true, detail: { summary: "Like a comment", tags: ["likes"] } },
  )
  .delete(
    "/:id/like",
    ({ user, params }) => unlike(user!.id, "comment", params.id),
    { auth: true, detail: { summary: "Unlike a comment", tags: ["likes"] } },
  );

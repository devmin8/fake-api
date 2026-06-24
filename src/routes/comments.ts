// Comment read routes — all public. Thin: parse/clamp the query, delegate to
// the comments service, return its result. Writes land in task-008.

import { Elysia, t } from "elysia";

import {
  listCommentReplies,
  listPostComments,
} from "~/services/comments.ts";

const clampLimit = (v?: number): number => {
  if (v === undefined || Number.isNaN(v)) return 20;
  return Math.max(1, Math.min(100, Math.floor(v)));
};

const listQuery = t.Object({
  cursor: t.Optional(t.String()),
  dir: t.Optional(t.Union([t.Literal("older"), t.Literal("newer")])),
  limit: t.Optional(t.Numeric()),
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

// Mount on postRoutes (inherits /api/posts prefix) for GET /:id/comments.
export const postCommentReadRoutes = new Elysia().get(
  "/:id/comments",
  listHandler(listPostComments),
  {
    query: listQuery,
    detail: { summary: "List top-level comments on a post", tags: ["comments"] },
  },
);

export const commentRoutes = new Elysia({ prefix: "/api/comments" }).get(
  "/:id/replies",
  listHandler(listCommentReplies),
  {
    query: listQuery,
    detail: { summary: "List replies under a comment", tags: ["comments"] },
  },
);

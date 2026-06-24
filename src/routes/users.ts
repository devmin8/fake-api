// User read routes — all public. Thin: parse/clamp the query, delegate to the
// users service, return its result. Writes land in later tasks.

import { Elysia, t } from "elysia";

import {
  getUserProfile,
  listUserFollowers,
  listUserFollowing,
  listUserPosts,
} from "~/services/users.ts";

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
  (
    fn: (
      username: string,
      params: { cursor?: string; dir: "older" | "newer"; limit: number },
    ) => unknown,
  ) =>
  ({
    params,
    query,
  }: {
    params: { username: string };
    query: { cursor?: string; dir?: "older" | "newer"; limit?: number };
  }) =>
    fn(params.username, {
      cursor: query.cursor,
      dir: query.dir ?? "older",
      limit: clampLimit(query.limit),
    });

export const userRoutes = new Elysia({ prefix: "/api/users" })
  // PUBLIC — profile with derived counts.
  .get("/:username", ({ params }) => getUserProfile(params.username), {
    detail: { summary: "User profile", tags: ["users"] },
  })

  // PUBLIC — paginated posts by this user.
  .get("/:username/posts", listHandler(listUserPosts), {
    query: listQuery,
    detail: { summary: "User posts", tags: ["users"] },
  })

  // PUBLIC — paginated followers.
  .get("/:username/followers", listHandler(listUserFollowers), {
    query: listQuery,
    detail: { summary: "User followers", tags: ["users"] },
  })

  // PUBLIC — paginated following.
  .get("/:username/following", listHandler(listUserFollowing), {
    query: listQuery,
    detail: { summary: "User following", tags: ["users"] },
  });

// User read routes — all public. Thin: parse/clamp the query, delegate to the
// users service, return its result. Writes land in later tasks.

import { Elysia, t } from "elysia";

import { listHandler, listQuery } from "~/lib/pagination.ts";

import { follow, unfollow } from "~/services/follows.ts";
import {
  getUserProfile,
  listUserFollowers,
  listUserFollowing,
  listUserPosts,
  updateMe,
} from "~/services/users.ts";

import { authGuard } from "~/plugins/auth-guard.ts";

// Self-edit body — every field optional; bio/avatarUrl accept null to clear.
const updateMeBody = t.Object({
  displayName: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
  bio: t.Optional(t.Union([t.String({ maxLength: 500 }), t.Null()])),
  avatarUrl: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])),
});

export const userRoutes = new Elysia({ prefix: "/api/users" })
  .use(authGuard)

  // AUTH — the caller's own profile edit. Declared before /:username so the
  // static "me" segment wins over the param.
  .patch("/me", ({ user, body }) => updateMe(user!.id, body), {
    auth: true,
    body: updateMeBody,
    detail: { summary: "Edit your profile", tags: ["users"] },
  })

  // PUBLIC — profile with derived counts.
  .get("/:username", ({ params }) => getUserProfile(params.username), {
    detail: { summary: "User profile", tags: ["users"] },
  })

  // AUTH — follow / unfollow a user. Idempotent toggles; both return the new
  // follower count.
  .post(
    "/:username/follow",
    ({ user, params }) => follow(user!.id, params.username),
    { auth: true, detail: { summary: "Follow a user", tags: ["follows"] } },
  )
  .delete(
    "/:username/follow",
    ({ user, params }) => unfollow(user!.id, params.username),
    { auth: true, detail: { summary: "Unfollow a user", tags: ["follows"] } },
  )

  // PUBLIC — paginated posts by this user.
  .get("/:username/posts", listHandler("username", listUserPosts), {
    query: listQuery,
    detail: { summary: "User posts", tags: ["users"] },
  })

  // PUBLIC — paginated followers.
  .get("/:username/followers", listHandler("username", listUserFollowers), {
    query: listQuery,
    detail: { summary: "User followers", tags: ["users"] },
  })

  // PUBLIC — paginated following.
  .get("/:username/following", listHandler("username", listUserFollowing), {
    query: listQuery,
    detail: { summary: "User following", tags: ["users"] },
  });

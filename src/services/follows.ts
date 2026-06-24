// Follows — the one write path for the social graph. follow/unfollow are
// idempotent toggles (following someone you already follow is a no-op), so the
// follower count can never drift and the client can fire either without first
// checking state. A fresh follow emits a notification to the followee; routes
// and (later) the firehose both call these so simulated and real data never
// diverge.

import { and, eq, sql } from "drizzle-orm";

import { db } from "~/db/index.ts";
import { follows, users } from "~/db/schema.ts";
import { errors } from "~/lib/errors.ts";

import { createNotification } from "~/services/notifications.ts";

export interface FollowResult {
  username: string;
  following: boolean;
  followerCount: number;
}

const requireUserByUsername = (username: string): { id: string } => {
  const user = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .get();
  if (!user) throw errors.notFound("User not found");
  return user;
};

const followerCountOf = (followeeId: string): number => {
  const row = db
    .select({ cnt: sql<number>`count(*)` })
    .from(follows)
    .where(eq(follows.followeeId, followeeId))
    .get();
  return Number(row?.cnt ?? 0);
};

export async function follow(
  followerId: string,
  username: string,
): Promise<FollowResult> {
  const followee = requireUserByUsername(username);
  if (followee.id === followerId) {
    throw errors.validation("You cannot follow yourself");
  }

  let created = false;
  db.transaction((tx) => {
    const existing = tx
      .select({ followerId: follows.followerId })
      .from(follows)
      .where(
        and(
          eq(follows.followerId, followerId),
          eq(follows.followeeId, followee.id),
        ),
      )
      .get();
    if (existing) return; // already following → idempotent no-op.

    tx.insert(follows)
      .values({ followerId, followeeId: followee.id })
      .run();
    created = true;
  });

  if (created) {
    createNotification({
      userId: followee.id,
      actorId: followerId,
      type: "follow",
      entityType: "user",
      entityId: followerId,
    });
  }

  return { username, following: true, followerCount: followerCountOf(followee.id) };
}

export async function unfollow(
  followerId: string,
  username: string,
): Promise<FollowResult> {
  const followee = requireUserByUsername(username);
  if (followee.id === followerId) {
    throw errors.validation("You cannot unfollow yourself");
  }

  db.delete(follows)
    .where(
      and(
        eq(follows.followerId, followerId),
        eq(follows.followeeId, followee.id),
      ),
    )
    .run();

  return { username, following: false, followerCount: followerCountOf(followee.id) };
}

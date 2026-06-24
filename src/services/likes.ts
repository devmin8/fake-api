// Likes — the one write path for the polymorphic like graph. A like targets a
// post or a comment via (target_type, target_id); both target tables carry a
// denormalized `like_count` that we bump in the SAME transaction as the like
// row, so the count and the rows can never drift (acceptance: counts never go
// below 0 or double-count). Routes and (later) the firehose both call these so
// simulated and real data never diverge. Broadcasts hook in at task-011 — the
// returned LikeResult already carries the new count a broadcaster needs.
//
// Double-like policy: IDEMPOTENT. Liking something you already like is a no-op
// that returns the current state (not a 409). Unliking something you don't like
// is likewise a no-op. This keeps the simulator simple (a bot never has to
// catch a conflict) and makes the count mathematically impossible to drift.

import { and, eq, sql } from "drizzle-orm";

import { db } from "~/db/index.ts";
import { comments, likes, posts } from "~/db/schema.ts";
import { errors } from "~/lib/errors.ts";
import { newId } from "~/lib/ids.ts";

import { createNotification } from "~/services/notifications.ts";

export type LikeTarget = "post" | "comment";

export interface LikeResult {
  targetType: LikeTarget;
  targetId: string;
  liked: boolean;
  likeCount: number;
}

// The target tables share the columns we touch (id, like_count); pick the right
// one by type. Kept here so like/unlike read and bump the same table.
const tableFor = (targetType: LikeTarget) =>
  targetType === "post" ? posts : comments;

// Load the target's current like_count and author, or 404 if it doesn't exist.
// The author is the recipient of the like notification.
const loadTarget = (
  targetType: LikeTarget,
  targetId: string,
): { likeCount: number; authorId: string } => {
  const table = tableFor(targetType);
  const row = db
    .select({ likeCount: table.likeCount, authorId: table.authorId })
    .from(table)
    .where(eq(table.id, targetId))
    .get();
  if (!row) {
    throw errors.notFound(
      targetType === "post" ? "Post not found" : "Comment not found",
    );
  }
  return row;
};

export async function like(
  userId: string,
  targetType: LikeTarget,
  targetId: string,
): Promise<LikeResult> {
  const table = tableFor(targetType);
  const target = loadTarget(targetType, targetId);
  let likeCount = target.likeCount;

  let created = false;
  db.transaction((tx) => {
    const existing = tx
      .select({ id: likes.id })
      .from(likes)
      .where(
        and(
          eq(likes.userId, userId),
          eq(likes.targetType, targetType),
          eq(likes.targetId, targetId),
        ),
      )
      .get();
    if (existing) return; // already liked → idempotent no-op, count unchanged.

    tx.insert(likes)
      .values({ id: newId(), userId, targetType, targetId })
      .run();
    tx.update(table)
      .set({ likeCount: sql`${table.likeCount} + 1` })
      .where(eq(table.id, targetId))
      .run();
    likeCount += 1;
    created = true;
  });

  // Only a fresh like notifies — a re-like is a silent no-op (self-likes drop
  // inside createNotification).
  if (created) {
    createNotification({
      userId: target.authorId,
      actorId: userId,
      type: "like",
      entityType: targetType,
      entityId: targetId,
    });
  }

  return { targetType, targetId, liked: true, likeCount };
}

export async function unlike(
  userId: string,
  targetType: LikeTarget,
  targetId: string,
): Promise<LikeResult> {
  const table = tableFor(targetType);
  let likeCount = loadTarget(targetType, targetId).likeCount;

  db.transaction((tx) => {
    const existing = tx
      .select({ id: likes.id })
      .from(likes)
      .where(
        and(
          eq(likes.userId, userId),
          eq(likes.targetType, targetType),
          eq(likes.targetId, targetId),
        ),
      )
      .get();
    if (!existing) return; // not liked → idempotent no-op, count unchanged.

    tx.delete(likes).where(eq(likes.id, existing.id)).run();
    tx.update(table)
      // max(0, …) is a belt-and-braces floor; the existence check above already
      // guarantees we only decrement a count we incremented.
      .set({ likeCount: sql`max(0, ${table.likeCount} - 1)` })
      .where(eq(table.id, targetId))
      .run();
    likeCount = Math.max(0, likeCount - 1);
  });

  return { targetType, targetId, liked: false, likeCount };
}

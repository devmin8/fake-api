// Comment reads — the one read path for threaded comments. Routes and (later)
// the firehose both call these so simulated and real data never diverge.
//
// Two surfaces:
//   - top-level comments on a post (parent_id IS NULL), each carrying a
//     denormalized replyCount so clients can show thread depth without an
//     extra round-trip;
//   - paginated replies under a single comment (parent_id = :id).
//
// Pagination reuses the same keyset cursor as posts: (created_at, id) tuple,
// dir=older (newest-first, default) or dir=newer (ascending-from-cursor).

import { type SQL, and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { db, sqlite } from "~/db/index.ts";
import { comments, likes, posts } from "~/db/schema.ts";
import {
  type Cursor,
  type Direction,
  type Envelope,
  decodeCursor,
  toEnvelope,
} from "~/lib/cursor.ts";
import { errors } from "~/lib/errors.ts";
import { newId } from "~/lib/ids.ts";

export interface CommentAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface PublicComment {
  id: string;
  postId: string;
  parentId: string | null;
  body: string;
  likeCount: number;
  replyCount: number;
  createdAt: string;
  author: CommentAuthor;
}

export interface ListCommentsParams {
  cursor?: string;
  dir: Direction;
  limit: number;
}

const commentWith = {
  author: {
    columns: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
    },
  },
} as const;

type HydratedComment = typeof comments.$inferSelect & {
  author: CommentAuthor;
};

const tupleLt = (c: Cursor) =>
  or(
    lt(comments.createdAt, c.createdAt),
    and(eq(comments.createdAt, c.createdAt), lt(comments.id, c.id)),
  );
const tupleGt = (c: Cursor) =>
  or(
    gt(comments.createdAt, c.createdAt),
    and(eq(comments.createdAt, c.createdAt), gt(comments.id, c.id)),
  );

// Batch reply counts for a page of parent comment ids.
const replyCounts = async (ids: string[]): Promise<Map<string, number>> => {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ parentId: comments.parentId, cnt: sql<number>`count(*)` })
    .from(comments)
    .where(inArray(comments.parentId, ids))
    .groupBy(comments.parentId);
  return new Map(rows.map((r) => [r.parentId!, Number(r.cnt)]));
};

const toPublicComment = (
  row: HydratedComment,
  replyCount: number,
): PublicComment => ({
  id: row.id,
  postId: row.postId,
  parentId: row.parentId,
  body: row.body,
  likeCount: row.likeCount,
  replyCount,
  createdAt: row.createdAt,
  author: row.author,
});

const paginateComments = async (
  baseConds: SQL[],
  params: ListCommentsParams,
): Promise<Envelope<PublicComment>> => {
  const { cursor, dir, limit } = params;
  const cur = cursor ? decodeCursor(cursor) : null;

  const filters: SQL[] = [...baseConds];
  if (cur) {
    const boundary = dir === "newer" ? tupleGt(cur) : tupleLt(cur);
    if (boundary) filters.push(boundary);
  }

  const orderBy =
    dir === "newer"
      ? [asc(comments.createdAt), asc(comments.id)]
      : [desc(comments.createdAt), desc(comments.id)];

  const idRows = await db
    .select({ id: comments.id })
    .from(comments)
    .where(and(...filters))
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = idRows.length > limit;
  const ids = idRows.slice(0, limit).map((r) => r.id);
  if (ids.length === 0) return toEnvelope<PublicComment>([], false);

  const rows = (await db.query.comments.findMany({
    where: inArray(comments.id, ids),
    with: commentWith,
  })) as HydratedComment[];

  const byId = new Map(rows.map((r) => [r.id, r]));
  const counts = await replyCounts(ids);

  const data = ids.map((id) =>
    toPublicComment(byId.get(id)!, counts.get(id) ?? 0),
  );

  return toEnvelope(data, hasMore);
};

export async function listPostComments(
  postId: string,
  params: ListCommentsParams,
): Promise<Envelope<PublicComment>> {
  const post = await db.query.posts.findFirst({
    where: eq(posts.id, postId),
    columns: { id: true },
  });
  if (!post) throw errors.notFound("Post not found");

  return paginateComments(
    [eq(comments.postId, postId), isNull(comments.parentId)],
    params,
  );
}

export async function listCommentReplies(
  commentId: string,
  params: ListCommentsParams,
): Promise<Envelope<PublicComment>> {
  const parent = await db.query.comments.findFirst({
    where: eq(comments.id, commentId),
    columns: { id: true },
  });
  if (!parent) throw errors.notFound("Comment not found");

  return paginateComments([eq(comments.parentId, commentId)], params);
}

// --- Writes -----------------------------------------------------------------
// Shared write path for comments. createComment bumps the post's denormalized
// comment_count in the same transaction as the insert, so the count and the
// rows can never drift. Broadcasts hook in at task-011.

export interface CreateCommentInput {
  body: string;
  // Optional: reply under an existing comment on the same post (null = top-level).
  parentId?: string | null;
}

export async function createComment(
  postId: string,
  authorId: string,
  input: CreateCommentInput,
): Promise<PublicComment> {
  const post = db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.id, postId))
    .get();
  if (!post) throw errors.notFound("Post not found");

  const parentId = input.parentId ?? null;
  if (parentId) {
    const parent = db
      .select({ postId: comments.postId })
      .from(comments)
      .where(eq(comments.id, parentId))
      .get();
    if (!parent || parent.postId !== postId) {
      throw errors.validation("parentId must reference a comment on this post");
    }
  }

  const id = newId();
  const createdAt = new Date().toISOString();

  db.transaction((tx) => {
    tx.insert(comments)
      .values({ id, postId, authorId, parentId, body: input.body, createdAt })
      .run();
    tx.update(posts)
      .set({ commentCount: sql`${posts.commentCount} + 1` })
      .where(eq(posts.id, postId))
      .run();
  });

  const row = (await db.query.comments.findFirst({
    where: eq(comments.id, id),
    with: commentWith,
  })) as HydratedComment;
  return toPublicComment(row, 0);
}

// Delete a comment the caller owns. Replies cascade via the parent_id FK; their
// polymorphic likes have no FK so we clear the whole subtree's likes by hand,
// and decrement the post's comment_count by the subtree size — every comment,
// reply included, bumped it by one on creation.
export async function deleteComment(id: string, userId: string): Promise<void> {
  const existing = db
    .select({ authorId: comments.authorId, postId: comments.postId })
    .from(comments)
    .where(eq(comments.id, id))
    .get();
  if (!existing) throw errors.notFound("Comment not found");
  if (existing.authorId !== userId) throw errors.forbidden();

  // The comment plus every descendant reply the cascade will remove.
  const subtreeIds = sqlite
    .query<{ id: string }, [string]>(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM comments WHERE id = ?
         UNION ALL
         SELECT c.id FROM comments c JOIN sub ON c.parent_id = sub.id
       )
       SELECT id FROM sub`,
    )
    .all(id)
    .map((r) => r.id);

  db.transaction((tx) => {
    tx.delete(likes)
      .where(
        and(eq(likes.targetType, "comment"), inArray(likes.targetId, subtreeIds)),
      )
      .run();
    tx.delete(comments).where(eq(comments.id, id)).run();
    tx.update(posts)
      .set({
        commentCount: sql`max(0, ${posts.commentCount} - ${subtreeIds.length})`,
      })
      .where(eq(posts.id, existing.postId))
      .run();
  });
}

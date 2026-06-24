// Bookmarks — a per-user save list over posts. No denormalized count anywhere
// (a bookmark is private to the user, so nothing public aggregates on it), which
// makes add/remove pure idempotent upserts/deletes. The one write path the
// firehose reuses too.
//
// Listing paginates by bookmark recency — the (bookmark.created_at, post_id)
// tuple, newest-first — not by the post's own time, so "most recently saved"
// stays correct even for an old post. We reuse the post hydrator so a bookmarked
// post looks identical to one from the feed.

import { and, desc, eq, lt, or } from "drizzle-orm";

import { db } from "~/db/index.ts";
import { bookmarks, posts } from "~/db/schema.ts";
import {
  type Envelope,
  decodeCursor,
  encodeCursor,
} from "~/lib/cursor.ts";
import { errors } from "~/lib/errors.ts";

import { type PublicPost, hydratePosts } from "./posts.ts";

export interface BookmarkResult {
  postId: string;
  bookmarked: boolean;
}

export interface ListBookmarksParams {
  cursor?: string;
  limit: number;
}

const assertPostExists = (postId: string): void => {
  const post = db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.id, postId))
    .get();
  if (!post) throw errors.notFound("Post not found");
};

// Idempotent: bookmarking an already-bookmarked post is a no-op (the composite
// PK + onConflictDoNothing swallow the duplicate), so the route stays a clean
// toggle the client can fire without first checking state.
export async function addBookmark(
  userId: string,
  postId: string,
): Promise<BookmarkResult> {
  assertPostExists(postId);
  db.insert(bookmarks).values({ userId, postId }).onConflictDoNothing().run();
  return { postId, bookmarked: true };
}

export async function removeBookmark(
  userId: string,
  postId: string,
): Promise<BookmarkResult> {
  assertPostExists(postId);
  db.delete(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.postId, postId)))
    .run();
  return { postId, bookmarked: false };
}

export async function listBookmarks(
  userId: string,
  params: ListBookmarksParams,
): Promise<Envelope<PublicPost>> {
  const { cursor, limit } = params;
  const cur = cursor ? decodeCursor(cursor) : null;

  const conds = [eq(bookmarks.userId, userId)];
  // Keyset on (created_at, post_id), strictly older than the cursor — same
  // tuple-comparison shape the post/comment feeds use, anchored on the bookmark.
  if (cur) {
    conds.push(
      or(
        lt(bookmarks.createdAt, cur.createdAt),
        and(
          eq(bookmarks.createdAt, cur.createdAt),
          lt(bookmarks.postId, cur.id),
        ),
      )!,
    );
  }

  const rows = await db
    .select({ postId: bookmarks.postId, createdAt: bookmarks.createdAt })
    .from(bookmarks)
    .where(and(...conds))
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.postId))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  if (page.length === 0) {
    return { data: [], newestCursor: null, oldestCursor: null, hasMore: false };
  }

  const data = await hydratePosts(page.map((r) => r.postId));
  const first = page[0]!;
  const last = page[page.length - 1]!;

  // Cursors encode the bookmark tuple (not the post's), so continuation keeps
  // paging by save-time. post_id doubles as the tuple's id half.
  return {
    data,
    newestCursor: encodeCursor(first.createdAt, first.postId),
    oldestCursor: encodeCursor(last.createdAt, last.postId),
    hasMore,
  };
}

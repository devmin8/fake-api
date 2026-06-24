// Post reads — the one read path. Routes and (later) the firehose both call
// these, so simulated and real data never diverge.
//
// Pagination is keyset, never offset: a cursor names a row and we scan strictly
// past it, so head inserts can't shift a page. Two regimes:
//   - chronological (sort=new): keyset on the (created_at, id) tuple, in either
//     direction. dir=newer returns ascending-from-cursor (adjacent-to-head
//     first) per the design's contract; dir=older returns newest-first.
//   - ranked (sort=top|trending): older-only within a ranked order. We resolve
//     the page as an ordered list of ids first (so the ranking expression lives
//     in one plain core query), then hydrate those ids with their relations.

import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";

import { db } from "~/db/index.ts";
import { postTags, posts, tags, users } from "~/db/schema.ts";
import {
  type Cursor,
  type Direction,
  type Envelope,
  decodeCursor,
  encodeCursor,
  toEnvelope,
} from "~/lib/cursor.ts";
import { errors } from "~/lib/errors.ts";

export type Sort = "new" | "top" | "trending";

export interface PostAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface PostTag {
  id: string;
  name: string;
  slug: string;
}

export interface PublicPost {
  id: string;
  title: string;
  body: string;
  imageUrl: string | null;
  likeCount: number;
  commentCount: number;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
  author: PostAuthor;
  tags: PostTag[];
}

export interface ListPostsParams {
  sort: Sort;
  tag?: string;
  author?: string;
  cursor?: string;
  dir: Direction;
  limit: number;
}

export interface PostUpdates {
  count: number;
  newestCursor: string | null;
  previews: { id: string; title: string; createdAt: string }[];
}

// Relations every public post carries: a light author card + its tags. We trim
// the author to the public profile fields a feed needs (no email/password_hash).
const postWith = {
  author: {
    columns: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
    },
  },
  postTags: { with: { tag: true } },
} as const;

type HydratedPost = typeof posts.$inferSelect & {
  author: PostAuthor;
  postTags: { tag: PostTag }[];
};

const toPublicPost = (row: HydratedPost): PublicPost => ({
  id: row.id,
  title: row.title,
  body: row.body,
  imageUrl: row.imageUrl,
  likeCount: row.likeCount,
  commentCount: row.commentCount,
  viewCount: row.viewCount,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  author: row.author,
  tags: row.postTags.map((pt) => pt.tag),
});

// (created_at, id) tuple comparisons — the chronological keyset boundaries.
const tupleLt = (c: Cursor) =>
  or(
    lt(posts.createdAt, c.createdAt),
    and(eq(posts.createdAt, c.createdAt), lt(posts.id, c.id)),
  );
const tupleGt = (c: Cursor) =>
  or(
    gt(posts.createdAt, c.createdAt),
    and(eq(posts.createdAt, c.createdAt), gt(posts.id, c.id)),
  );

// Trending blends likes + comments and decays with age. Expressed once in SQL
// for the ordering/keyset; `trendingScore` mirrors it in JS to derive the
// boundary value of the cursor's anchor row. julianday('now') ≈ Date.now().
const trendingScoreSql = sql<number>`(${posts.likeCount} + 2 * ${posts.commentCount}) / ((julianday('now') - julianday(${posts.createdAt})) * 24.0 + 2)`;

const trendingScore = (p: {
  likeCount: number;
  commentCount: number;
  createdAt: string;
}): number => {
  const ageHours = (Date.now() - new Date(p.createdAt).getTime()) / 3_600_000;
  return (p.likeCount + 2 * p.commentCount) / (ageHours + 2);
};

// Hydrate an ordered list of ids back into public posts, preserving the order
// the id query produced (a WHERE IN doesn't guarantee it).
const hydrate = async (ids: string[]): Promise<PublicPost[]> => {
  const rows = (await db.query.posts.findMany({
    where: inArray(posts.id, ids),
    with: postWith,
  })) as HydratedPost[];
  const byId = new Map(rows.map((r) => [r.id, toPublicPost(r)]));
  return ids.map((id) => byId.get(id)!);
};

export async function listPosts(
  params: ListPostsParams,
): Promise<Envelope<PublicPost>> {
  const { sort, tag, author, cursor, dir, limit } = params;
  const cur = cursor ? decodeCursor(cursor) : null;
  const ranked = sort === "top" || sort === "trending";

  const conds = [];

  // Filters narrow the candidate set before sorting/paging.
  if (tag) {
    conds.push(
      inArray(
        posts.id,
        db
          .select({ id: postTags.postId })
          .from(postTags)
          .innerJoin(tags, eq(postTags.tagId, tags.id))
          .where(or(eq(tags.slug, tag), eq(tags.name, tag))),
      ),
    );
  }
  if (author) {
    conds.push(
      inArray(
        posts.authorId,
        db
          .select({ id: users.id })
          .from(users)
          .where(or(eq(users.id, author), eq(users.username, author))),
      ),
    );
  }

  let orderBy;
  if (!ranked) {
    if (cur) conds.push(dir === "newer" ? tupleGt(cur) : tupleLt(cur));
    orderBy =
      dir === "newer"
        ? [asc(posts.createdAt), asc(posts.id)]
        : [desc(posts.createdAt), desc(posts.id)];
  } else {
    const scoreSql = sort === "top" ? sql<number>`${posts.likeCount}` : trendingScoreSql;
    if (cur) {
      // Recover the anchor's score so we can scan strictly "below" it in rank,
      // tie-broken by the chronological tuple for a stable total order.
      const anchor = await db.query.posts.findFirst({
        where: eq(posts.id, cur.id),
        columns: { likeCount: true, commentCount: true, createdAt: true },
      });
      if (anchor) {
        const boundary = sort === "top" ? anchor.likeCount : trendingScore(anchor);
        conds.push(
          sql`(${scoreSql} < ${boundary} OR (${scoreSql} = ${boundary} AND (${posts.createdAt} < ${cur.createdAt} OR (${posts.createdAt} = ${cur.createdAt} AND ${posts.id} < ${cur.id}))))`,
        );
      }
    }
    orderBy = [desc(scoreSql), desc(posts.createdAt), desc(posts.id)];
  }

  // Resolve the page as ordered ids (+1 to detect more), then hydrate.
  const idRows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = idRows.length > limit;
  const ids = idRows.slice(0, limit).map((r) => r.id);
  if (ids.length === 0) return toEnvelope<PublicPost>([], false, { ranked });

  return toEnvelope(await hydrate(ids), hasMore, { ranked });
}

// Detail read. Increments view_count by 1 per call (the broadcast is wired in
// task-011) and reflects the bump in the returned object.
export async function getPostById(id: string): Promise<PublicPost> {
  const row = (await db.query.posts.findFirst({
    where: eq(posts.id, id),
    with: postWith,
  })) as HydratedPost | undefined;
  if (!row) throw errors.notFound("Post not found");

  db.update(posts)
    .set({ viewCount: sql`${posts.viewCount} + 1` })
    .where(eq(posts.id, id))
    .run();

  const post = toPublicPost(row);
  post.viewCount += 1;
  return post;
}

// Cheap "how many newer" head-check for the new-posts banner. Reports the count
// of posts strictly newer than `since`, plus the current head cursor and a few
// previews so a client can render the banner without a second round-trip.
export async function postUpdates(since: string): Promise<PostUpdates> {
  const cur = decodeCursor(since);

  const head = await db.query.posts.findFirst({
    orderBy: [desc(posts.createdAt), desc(posts.id)],
    columns: { createdAt: true, id: true },
  });
  const newestCursor = head ? encodeCursor(head.createdAt, head.id) : null;

  const newer = await db
    .select({ id: posts.id, title: posts.title, createdAt: posts.createdAt })
    .from(posts)
    .where(tupleGt(cur))
    .orderBy(desc(posts.createdAt), desc(posts.id));

  return {
    count: newer.length,
    newestCursor,
    previews: newer.slice(0, 5),
  };
}

// Feed — the personalized timeline: posts from the people you follow, newest
// first. A thin read built on the posts service so a feed post looks identical
// to one from anywhere else and the keyset pagination is the exact same code
// path. Follow nobody → an empty feed (we don't fall back to a global list).

import { eq } from "drizzle-orm";

import { db } from "~/db/index.ts";
import { follows } from "~/db/schema.ts";
import { type Direction, type Envelope, toEnvelope } from "~/lib/cursor.ts";

import { type PublicPost, listPosts } from "~/services/posts.ts";

export interface ListFeedParams {
  cursor?: string;
  dir: Direction;
  limit: number;
}

export async function listFeed(
  userId: string,
  params: ListFeedParams,
): Promise<Envelope<PublicPost>> {
  const followed = await db
    .select({ id: follows.followeeId })
    .from(follows)
    .where(eq(follows.followerId, userId));

  const authorIds = followed.map((r) => r.id);
  if (authorIds.length === 0) return toEnvelope<PublicPost>([], false);

  return listPosts({
    sort: "new",
    authorIds,
    cursor: params.cursor,
    dir: params.dir,
    limit: params.limit,
  });
}

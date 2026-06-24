// Tag reads — the tag index with post counts and paginated posts per tag. Routes
// and (later) the firehose both call these so simulated and real data never diverge.

import { eq, sql } from "drizzle-orm";

import { db } from "~/db/index.ts";
import { postTags, tags } from "~/db/schema.ts";
import { type Direction, type Envelope } from "~/lib/cursor.ts";
import { errors } from "~/lib/errors.ts";

import { listPosts, type PublicPost } from "~/services/posts.ts";

export interface PublicTag {
  id: string;
  name: string;
  slug: string;
  postCount: number;
}

export interface ListTagPostsParams {
  cursor?: string;
  dir: Direction;
  limit: number;
}

export async function listTags(): Promise<Envelope<PublicTag>> {
  const rows = await db
    .select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      postCount: sql<number>`count(${postTags.postId})`,
    })
    .from(tags)
    .leftJoin(postTags, eq(postTags.tagId, tags.id))
    .groupBy(tags.id)
    .orderBy(tags.name);

  const data: PublicTag[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    postCount: Number(r.postCount),
  }));

  return { data, newestCursor: null, oldestCursor: null, hasMore: false };
}

export async function listTagPosts(
  slug: string,
  params: ListTagPostsParams,
): Promise<Envelope<PublicPost>> {
  const tag = await db.query.tags.findFirst({
    where: eq(tags.slug, slug),
    columns: { id: true },
  });
  if (!tag) throw errors.notFound("Tag not found");

  return listPosts({
    sort: "new",
    tag: slug,
    cursor: params.cursor,
    dir: params.dir,
    limit: params.limit,
  });
}

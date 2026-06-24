// User reads — profiles, a user's posts, and follower/following lists. Routes
// and (later) the firehose both call these so simulated and real data never diverge.

import { type SQL, and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";

import { db } from "~/db/index.ts";
import { follows, posts, users } from "~/db/schema.ts";
import {
  type Cursor,
  type Direction,
  type Envelope,
  decodeCursor,
  toEnvelope,
} from "~/lib/cursor.ts";
import { errors } from "~/lib/errors.ts";

import { type PublicUser, toPublicUser } from "~/plugins/auth-guard.ts";
import { listPosts, type PublicPost } from "~/services/posts.ts";

export interface PublicProfile {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  isBot: boolean;
  createdAt: string;
  postCount: number;
  followerCount: number;
  followingCount: number;
}

export interface PublicUserCard {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: string;
}

export interface ListUserPostsParams {
  cursor?: string;
  dir: Direction;
  limit: number;
}

export interface ListFollowParams {
  cursor?: string;
  dir: Direction;
  limit: number;
}

// Self-edit: only these three fields are mutable; everything else (username,
// email, isBot) is fixed after registration. An omitted key leaves the column
// untouched; bio/avatarUrl accept null to clear.
export interface UpdateMeInput {
  displayName?: string;
  bio?: string | null;
  avatarUrl?: string | null;
}

const publicUserColumns = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

const requireUser = async (username: string) => {
  const user = await db.query.users.findFirst({
    where: eq(users.username, username),
    columns: { id: true },
  });
  if (!user) throw errors.notFound("User not found");
  return user;
};

export async function getUserProfile(username: string): Promise<PublicProfile> {
  const row = await db.query.users.findFirst({
    where: eq(users.username, username),
    columns: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      bio: true,
      isBot: true,
      createdAt: true,
    },
  });
  if (!row) throw errors.notFound("User not found");

  const [postCountRow, followerCountRow, followingCountRow] = await Promise.all([
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(posts)
      .where(eq(posts.authorId, row.id)),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(follows)
      .where(eq(follows.followeeId, row.id)),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(follows)
      .where(eq(follows.followerId, row.id)),
  ]);

  return {
    ...row,
    postCount: Number(postCountRow[0]?.cnt ?? 0),
    followerCount: Number(followerCountRow[0]?.cnt ?? 0),
    followingCount: Number(followingCountRow[0]?.cnt ?? 0),
  };
}

export async function listUserPosts(
  username: string,
  params: ListUserPostsParams,
): Promise<Envelope<PublicPost>> {
  await requireUser(username);
  return listPosts({
    sort: "new",
    author: username,
    cursor: params.cursor,
    dir: params.dir,
    limit: params.limit,
  });
}

// Paginate a user's followers or following via the follows row's (created_at,
// peer user id) tuple — unique within each list, stable for keyset paging.
type FollowIdCol = typeof follows.followerId | typeof follows.followeeId;

const tupleLt = (c: Cursor, createdAtCol: typeof follows.createdAt, idCol: FollowIdCol) =>
  or(
    lt(createdAtCol, c.createdAt),
    and(eq(createdAtCol, c.createdAt), lt(idCol, c.id)),
  );
const tupleGt = (c: Cursor, createdAtCol: typeof follows.createdAt, idCol: FollowIdCol) =>
  or(
    gt(createdAtCol, c.createdAt),
    and(eq(createdAtCol, c.createdAt), gt(idCol, c.id)),
  );

const paginateFollowUsers = async (
  username: string,
  mode: "followers" | "following",
  params: ListFollowParams,
): Promise<Envelope<PublicUserCard>> => {
  const user = await requireUser(username);
  const { cursor, dir, limit } = params;
  const cur = cursor ? decodeCursor(cursor) : null;

  const peerCol = mode === "followers" ? follows.followerId : follows.followeeId;
  const anchorCol =
    mode === "followers" ? follows.followeeId : follows.followerId;

  const filters: SQL[] = [eq(anchorCol, user.id)];
  if (cur) {
    const boundary =
      dir === "newer" ? tupleGt(cur, follows.createdAt, peerCol) : tupleLt(cur, follows.createdAt, peerCol);
    if (boundary) filters.push(boundary);
  }

  const orderBy =
    dir === "newer"
      ? [asc(follows.createdAt), asc(peerCol)]
      : [desc(follows.createdAt), desc(peerCol)];

  const edgeRows = await db
    .select({ peerId: peerCol, createdAt: follows.createdAt })
    .from(follows)
    .where(and(...filters))
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = edgeRows.length > limit;
  const page = edgeRows.slice(0, limit);
  if (page.length === 0) return toEnvelope<PublicUserCard>([], false);

  const peerIds = page.map((r) => r.peerId);
  const userRows = await db.query.users.findMany({
    where: inArray(users.id, peerIds),
    columns: publicUserColumns,
  });
  const byId = new Map(userRows.map((u) => [u.id, u]));

  const data: PublicUserCard[] = page.map((edge) => {
    const card = byId.get(edge.peerId)!;
    return { ...card, createdAt: edge.createdAt };
  });

  return toEnvelope(data, hasMore);
};

export async function listUserFollowers(
  username: string,
  params: ListFollowParams,
): Promise<Envelope<PublicUserCard>> {
  return paginateFollowUsers(username, "followers", params);
}

export async function listUserFollowing(
  username: string,
  params: ListFollowParams,
): Promise<Envelope<PublicUserCard>> {
  return paginateFollowUsers(username, "following", params);
}

// The caller's own profile edit. Touches only the allowed columns, stamps
// updated_at, and returns the full public user (including email — it's the
// owner reading their own row).
export async function updateMe(
  userId: string,
  input: UpdateMeInput,
): Promise<PublicUser> {
  const set: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };
  if (input.displayName !== undefined) set.displayName = input.displayName;
  if (input.bio !== undefined) set.bio = input.bio;
  if (input.avatarUrl !== undefined) set.avatarUrl = input.avatarUrl;

  db.update(users).set(set).where(eq(users.id, userId)).run();

  const row = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!row) throw errors.notFound("User not found");
  return toPublicUser(row);
}

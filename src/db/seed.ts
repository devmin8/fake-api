// Faker-powered seed. Fills every table with believable, relationally-consistent
// data so the read endpoints built next have something to return, and the firehose
// has bot users to act as. Running it is destructive: it WIPES every table, then
// reseeds in one transaction (`bun run db:seed`). No flag needed — a seed run is
// always a fresh start.
//
// Two invariants the rest of the system leans on:
//   1. A fixed test user (alice@example.com / password123) whose password_hash
//      verifies against the Bruno env's testPassword, so task-004's login works.
//      Every seeded user shares that password, so you can log in as anyone.
//   2. Denormalized counts (posts.like_count/comment_count, comments.like_count)
//      exactly match the child rows created here — they're tallied in memory as
//      we build, never guessed.

import { faker } from "@faker-js/faker";

import { db, sqlite } from "~/db/index.ts";
import { newId } from "~/lib/ids.ts";

import * as schema from "./schema.ts";

// Deterministic run: same data every reseed, so chained tests/cursors are stable.
faker.seed(20260624);

const REAL_USERS = 20;
const BOT_USERS = 6;
const POST_COUNT = 80;

const now = Date.now();
const DAY = 86_400_000;

// A random epoch-ms in [from, now]. Used to backdate rows so a child (comment,
// like) never predates its parent (post) and ULIDs sort by real creation time.
const between = (from: number): number =>
  faker.number.int({ min: Math.min(from, now), max: now });

const iso = (ms: number): string => new Date(ms).toISOString();

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// ---------------------------------------------------------------------------
// 1 · Users  (1 fixed test user · rest real · a handful of bots)
// ---------------------------------------------------------------------------

type UserRow = typeof schema.users.$inferInsert;

const passwordHash = await Bun.password.hash("password123");

const users: UserRow[] = [];
const userCreatedMs = new Map<string, number>();
const usernames = new Set<string>();

const uniqueUsername = (base: string): string => {
  let name = slugify(base) || "user";
  let n = 1;
  while (usernames.has(name)) name = `${slugify(base)}${n++}`;
  usernames.add(name);
  return name;
};

const pushUser = (opts: {
  username: string;
  email: string;
  displayName: string;
  isBot: boolean;
  createdMs: number;
}): UserRow => {
  const id = newId(opts.createdMs);
  const row: UserRow = {
    id,
    username: opts.username,
    email: opts.email,
    passwordHash,
    displayName: opts.displayName,
    avatarUrl: faker.image.avatarGitHub(),
    bio: faker.person.bio(),
    isBot: opts.isBot,
    createdAt: iso(opts.createdMs),
    updatedAt: iso(opts.createdMs),
  };
  users.push(row);
  userCreatedMs.set(id, opts.createdMs);
  return row;
};

// The known test user — oldest account, fixed credentials from the Bruno env.
usernames.add("alice");
pushUser({
  username: "alice",
  email: "alice@example.com",
  displayName: "Alice",
  isBot: false,
  createdMs: now - 90 * DAY,
});

for (let i = 0; i < REAL_USERS - 1; i++) {
  const first = faker.person.firstName();
  const last = faker.person.lastName();
  const username = uniqueUsername(`${first}${last}`);
  pushUser({
    username,
    email: `${username}@example.com`,
    displayName: `${first} ${last}`,
    isBot: false,
    createdMs: between(now - 75 * DAY),
  });
}

for (let i = 0; i < BOT_USERS; i++) {
  const username = uniqueUsername(`bot ${faker.hacker.noun()} ${i}`);
  pushUser({
    username,
    email: `${username}@bots.fake-api.local`,
    displayName: `${faker.hacker.adjective()} bot`,
    isBot: true,
    createdMs: now - 80 * DAY,
  });
}

const allUserIds = users.map((u) => u.id);
const pickUser = (): string => faker.helpers.arrayElement(allUserIds);

// ---------------------------------------------------------------------------
// 2 · Tags  (curated pool → guaranteed-unique name + slug)
// ---------------------------------------------------------------------------

type TagRow = typeof schema.tags.$inferInsert;

const TAG_NAMES = [
  "JavaScript",
  "TypeScript",
  "React",
  "Node.js",
  "Bun",
  "Databases",
  "DevOps",
  "Design",
  "Productivity",
  "Career",
  "Open Source",
  "Security",
  "AI",
  "WebDev",
  "Testing",
];

const tags: TagRow[] = TAG_NAMES.map((name) => ({
  id: newId(now - 85 * DAY),
  name,
  slug: slugify(name),
}));

// ---------------------------------------------------------------------------
// 3 · Posts (+ post_tags). Counts start at 0; bumped as children are built.
// ---------------------------------------------------------------------------

type PostRow = typeof schema.posts.$inferInsert;
type PostTagRow = typeof schema.postTags.$inferInsert;

const posts: PostRow[] = [];
const postTags: PostTagRow[] = [];
const postCreatedMs = new Map<string, number>();

for (let i = 0; i < POST_COUNT; i++) {
  const authorId = pickUser();
  const createdMs = between(userCreatedMs.get(authorId)!);
  const id = newId(createdMs);
  const hasImage = faker.datatype.boolean(0.4);
  posts.push({
    id,
    authorId,
    title: faker.lorem.sentence({ min: 3, max: 8 }),
    body: faker.lorem.paragraphs({ min: 1, max: 4 }, "\n\n"),
    imageUrl: hasImage ? `https://picsum.photos/seed/${id}/800/600` : null,
    likeCount: 0,
    commentCount: 0,
    viewCount: faker.number.int({ min: 0, max: 5000 }),
    createdAt: iso(createdMs),
    updatedAt: iso(createdMs),
  });
  postCreatedMs.set(id, createdMs);

  const chosen = faker.helpers.arrayElements(tags, { min: 1, max: 3 });
  for (const tag of chosen) postTags.push({ postId: id, tagId: tag.id });
}

// ---------------------------------------------------------------------------
// 4 · Comments — threaded. A reply points at an earlier comment on the SAME post,
// so the parent always exists (and is inserted) before the child.
// ---------------------------------------------------------------------------

type CommentRow = typeof schema.comments.$inferInsert;

const comments: CommentRow[] = [];
const commentCreatedMs = new Map<string, number>();
const commentLikeCount = new Map<string, number>();

for (const post of posts) {
  const n = faker.number.int({ min: 0, max: 8 });
  const onThisPost: string[] = [];
  const postMs = postCreatedMs.get(post.id!)!;

  for (let i = 0; i < n; i++) {
    const createdMs = between(postMs);
    const id = newId(createdMs);
    const parentId =
      onThisPost.length > 0 && faker.datatype.boolean(0.3)
        ? faker.helpers.arrayElement(onThisPost)
        : null;
    comments.push({
      id,
      postId: post.id!,
      authorId: pickUser(),
      parentId,
      body: faker.lorem.sentences({ min: 1, max: 3 }),
      likeCount: 0,
      createdAt: iso(createdMs),
    });
    commentCreatedMs.set(id, createdMs);
    onThisPost.push(id);
    post.commentCount! += 1;
  }
}

// ---------------------------------------------------------------------------
// 5 · Likes — polymorphic over posts and comments, unique per (user,target).
// Each like bumps the denormalized count on its target.
// ---------------------------------------------------------------------------

type LikeRow = typeof schema.likes.$inferInsert;

const likes: LikeRow[] = [];
const likeSeen = new Set<string>(); // `${userId}:${type}:${targetId}`

const addLike = (
  userId: string,
  targetType: "post" | "comment",
  targetId: string,
  afterMs: number,
): void => {
  const key = `${userId}:${targetType}:${targetId}`;
  if (likeSeen.has(key)) return;
  likeSeen.add(key);
  const createdMs = between(afterMs);
  likes.push({
    id: newId(createdMs),
    userId,
    targetType,
    targetId,
    createdAt: iso(createdMs),
  });
};

for (const post of posts) {
  const likers = faker.helpers.arrayElements(allUserIds, {
    min: 0,
    max: Math.min(15, allUserIds.length),
  });
  for (const userId of likers) {
    addLike(userId, "post", post.id!, postCreatedMs.get(post.id!)!);
    post.likeCount! += 1;
  }
}

for (const comment of comments) {
  const likers = faker.helpers.arrayElements(allUserIds, { min: 0, max: 6 });
  for (const userId of likers) {
    addLike(userId, "comment", comment.id!, commentCreatedMs.get(comment.id!)!);
    commentLikeCount.set(comment.id!, (commentLikeCount.get(comment.id!) ?? 0) + 1);
  }
}

for (const comment of comments) {
  comment.likeCount = commentLikeCount.get(comment.id!) ?? 0;
}

// ---------------------------------------------------------------------------
// 6 · Follows — directed, unique per (follower,followee), never self.
// ---------------------------------------------------------------------------

type FollowRow = typeof schema.follows.$inferInsert;

const follows: FollowRow[] = [];
const followSeen = new Set<string>();

for (const followerId of allUserIds) {
  const targets = faker.helpers.arrayElements(allUserIds, { min: 2, max: 8 });
  for (const followeeId of targets) {
    if (followeeId === followerId) continue;
    const key = `${followerId}:${followeeId}`;
    if (followSeen.has(key)) continue;
    followSeen.add(key);
    const afterMs = Math.max(
      userCreatedMs.get(followerId)!,
      userCreatedMs.get(followeeId)!,
    );
    follows.push({
      followerId,
      followeeId,
      createdAt: iso(between(afterMs)),
    });
  }
}

// ---------------------------------------------------------------------------
// 7 · Bookmarks — unique per (user,post).
// ---------------------------------------------------------------------------

type BookmarkRow = typeof schema.bookmarks.$inferInsert;

const bookmarks: BookmarkRow[] = [];
const bookmarkSeen = new Set<string>();

for (const userId of allUserIds) {
  const saved = faker.helpers.arrayElements(posts, { min: 0, max: 5 });
  for (const post of saved) {
    const key = `${userId}:${post.id}`;
    if (bookmarkSeen.has(key)) continue;
    bookmarkSeen.add(key);
    bookmarks.push({
      userId,
      postId: post.id!,
      createdAt: iso(between(postCreatedMs.get(post.id!)!)),
    });
  }
}

// ---------------------------------------------------------------------------
// 8 · Notifications — derived from the actions above (someone liked/commented on
// your post, or followed you). Self-actions don't notify. Keep the freshest 150.
// ---------------------------------------------------------------------------

type NotificationRow = typeof schema.notifications.$inferInsert;

const postAuthor = new Map<string, string>(posts.map((p) => [p.id!, p.authorId]));
const allNotifications: NotificationRow[] = [];

const pushNotification = (
  userId: string,
  actorId: string,
  type: string,
  entityType: string,
  entityId: string,
  ms: number,
): void => {
  if (userId === actorId) return;
  allNotifications.push({
    id: newId(ms),
    userId,
    type,
    actorId,
    entityType,
    entityId,
    isRead: faker.datatype.boolean(0.5),
    createdAt: iso(ms),
  });
};

for (const comment of comments) {
  pushNotification(
    postAuthor.get(comment.postId!)!,
    comment.authorId,
    "comment",
    "post",
    comment.postId!,
    commentCreatedMs.get(comment.id!)!,
  );
}

for (const like of likes) {
  if (like.targetType !== "post") continue;
  pushNotification(
    postAuthor.get(like.targetId)!,
    like.userId,
    "like",
    "post",
    like.targetId,
    new Date(like.createdAt!).getTime(),
  );
}

for (const follow of follows) {
  pushNotification(
    follow.followeeId,
    follow.followerId,
    "follow",
    "user",
    follow.followerId,
    new Date(follow.createdAt!).getTime(),
  );
}

const notifications = allNotifications
  .sort((a, b) => (a.createdAt! < b.createdAt! ? 1 : -1))
  .slice(0, 150);

// ---------------------------------------------------------------------------
// 9 · Persist. Everything above only built plain JS arrays in memory — the DB
// hasn't been touched yet. This is the first and only block that writes to it.
//
// We wipe before inserting so the script is re-runnable: the delete clears rows
// left by a PREVIOUS `db:seed` (on a fresh DB it's a no-op), NOT anything built
// this run. Without it, a second run would hit alice's UNIQUE email and crash.
//
// Wipe child→parent, insert parent→child (FKs are ON, so a row can't reference a
// missing parent). The whole thing is one transaction, so a failure mid-way rolls
// back — you never get a half-wiped or half-seeded DB. Inserts are chunked to stay
// under SQLite's bound-variable limit.
// ---------------------------------------------------------------------------

const CHUNK = 100;

db.transaction((tx) => {
  // Delete child tables before their parents: an FK won't let us drop a row that
  // another table still points at. So everything referencing `users` goes first,
  // and `users` (referenced by all) goes last.
  tx.delete(schema.notifications).run();
  tx.delete(schema.media).run();
  tx.delete(schema.bookmarks).run();
  tx.delete(schema.follows).run();
  tx.delete(schema.likes).run();
  tx.delete(schema.postTags).run();
  tx.delete(schema.comments).run();
  tx.delete(schema.posts).run();
  tx.delete(schema.refreshTokens).run();
  tx.delete(schema.tags).run();
  tx.delete(schema.users).run();

  const insert = <T>(table: any, rows: T[]): void => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      tx.insert(table).values(rows.slice(i, i + CHUNK)).run();
    }
  };

  insert(schema.users, users);
  insert(schema.tags, tags);
  insert(schema.posts, posts);
  insert(schema.postTags, postTags);
  insert(schema.comments, comments);
  insert(schema.likes, likes);
  insert(schema.follows, follows);
  insert(schema.bookmarks, bookmarks);
  insert(schema.notifications, notifications);
});

console.log("✅ seed complete");
console.table({
  users: users.length,
  tags: tags.length,
  posts: posts.length,
  post_tags: postTags.length,
  comments: comments.length,
  likes: likes.length,
  follows: follows.length,
  bookmarks: bookmarks.length,
  notifications: notifications.length,
});
console.log(
  `   test user: alice@example.com / password123 (all ${users.length} users share this password)`,
);

sqlite.close();

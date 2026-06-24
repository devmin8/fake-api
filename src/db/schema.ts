// The full relational schema. ULID text primary keys (time-sortable, double as
// pagination cursors). Timestamps are ISO-8601 UTC text. Counts on posts/comments
// are denormalized and bumped in the same transaction as the action that changes
// them, so live broadcasts are cheap and reads never aggregate.
//
// FKs use ON DELETE CASCADE wherever a child can't outlive its parent (a comment
// without its post, a like without its user, a join-row without either side).

import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

// ISO-8601 UTC with milliseconds + trailing Z, e.g. 2026-06-24T12:34:56.789Z.
// Used as the DB-side default so seed/sim/manual inserts all get a sane stamp;
// services may still set timestamps explicitly when they need exact control.
const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  isBot: integer("is_bot", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(isoNow),
  updatedAt: text("updated_at").notNull().default(isoNow),
});

export const posts = sqliteTable(
  "posts",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    imageUrl: text("image_url"),
    likeCount: integer("like_count").notNull().default(0),
    commentCount: integer("comment_count").notNull().default(0),
    viewCount: integer("view_count").notNull().default(0),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (t) => [
    index("posts_author_idx").on(t.authorId),
    index("posts_created_idx").on(t.createdAt),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    postId: text("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Self-reference for threaded replies; null = top-level comment.
    parentId: text("parent_id").references((): any => comments.id, {
      onDelete: "cascade",
    }),
    body: text("body").notNull(),
    likeCount: integer("like_count").notNull().default(0),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    index("comments_post_idx").on(t.postId),
    index("comments_parent_idx").on(t.parentId),
  ],
);

// Polymorphic: a like targets a post or a comment via (target_type, target_id).
// No FK on target_id (it spans two tables); the unique guard stops double-likes.
export const likes = sqliteTable(
  "likes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetType: text("target_type", { enum: ["post", "comment"] }).notNull(),
    targetId: text("target_id").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    unique("likes_user_target_uq").on(t.userId, t.targetType, t.targetId),
    index("likes_target_idx").on(t.targetType, t.targetId),
  ],
);

export const follows = sqliteTable(
  "follows",
  {
    followerId: text("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followeeId: text("followee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.followeeId] }),
    index("follows_followee_idx").on(t.followeeId),
  ],
);

export const bookmarks = sqliteTable(
  "bookmarks",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    postId: text("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.postId] }),
    index("bookmarks_post_idx").on(t.postId),
  ],
);

export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
});

export const postTags = sqliteTable(
  "post_tags",
  {
    postId: text("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.tagId] }),
    index("post_tags_tag_idx").on(t.tagId),
  ],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    // Recipient.
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    // Who triggered it (liker, commenter, follower — real user or bot).
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.isRead)],
);

export const refreshTokens = sqliteTable(
  "refresh_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    revoked: integer("revoked", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (t) => [index("refresh_tokens_user_idx").on(t.userId)],
);

export const media = sqliteTable("media", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  url: text("url").notNull(),
  createdAt: text("created_at").notNull().default(isoNow),
});

// --- Relations (Drizzle relational query API) ---

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
  comments: many(comments),
  likes: many(likes),
  bookmarks: many(bookmarks),
  media: many(media),
  refreshTokens: many(refreshTokens),
  following: many(follows, { relationName: "follower" }),
  followers: many(follows, { relationName: "followee" }),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
  comments: many(comments),
  bookmarks: many(bookmarks),
  postTags: many(postTags),
}));

export const commentsRelations = relations(comments, ({ one, many }) => ({
  post: one(posts, { fields: [comments.postId], references: [posts.id] }),
  author: one(users, { fields: [comments.authorId], references: [users.id] }),
  parent: one(comments, {
    fields: [comments.parentId],
    references: [comments.id],
    relationName: "thread",
  }),
  replies: many(comments, { relationName: "thread" }),
}));

export const likesRelations = relations(likes, ({ one }) => ({
  user: one(users, { fields: [likes.userId], references: [users.id] }),
}));

export const followsRelations = relations(follows, ({ one }) => ({
  follower: one(users, {
    fields: [follows.followerId],
    references: [users.id],
    relationName: "follower",
  }),
  followee: one(users, {
    fields: [follows.followeeId],
    references: [users.id],
    relationName: "followee",
  }),
}));

export const bookmarksRelations = relations(bookmarks, ({ one }) => ({
  user: one(users, { fields: [bookmarks.userId], references: [users.id] }),
  post: one(posts, { fields: [bookmarks.postId], references: [posts.id] }),
}));

export const postTagsRelations = relations(postTags, ({ one }) => ({
  post: one(posts, { fields: [postTags.postId], references: [posts.id] }),
  tag: one(tags, { fields: [postTags.tagId], references: [tags.id] }),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  postTags: many(postTags),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  recipient: one(users, {
    fields: [notifications.userId],
    references: [users.id],
    relationName: "recipient",
  }),
  actor: one(users, {
    fields: [notifications.actorId],
    references: [users.id],
    relationName: "actor",
  }),
}));

export const mediaRelations = relations(media, ({ one }) => ({
  owner: one(users, { fields: [media.ownerId], references: [users.id] }),
}));

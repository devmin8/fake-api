// Notifications — the one write/read path for the per-user notification inbox.
// `createNotification` is the single emitter; the likes/comments/follows services
// call it whenever they act on someone else's content, and (later) the firehose
// reuses it too so simulated and real notifications never diverge.
//
// Self-actions never notify: liking your own post or following yourself (guarded
// elsewhere) would write a notification addressed to the actor, so we drop those
// at the source — recipient === actor is always a no-op.
//
// Reads paginate newest-first on the (created_at, id) keyset tuple, the same
// shape posts/comments use, with an optional unread-only filter.

import { type SQL, and, asc, desc, eq, gt, inArray, lt, or } from "drizzle-orm";

import { db } from "~/db/index.ts";
import { notifications } from "~/db/schema.ts";
import {
  type Cursor,
  type Direction,
  type Envelope,
  decodeCursor,
  toEnvelope,
} from "~/lib/cursor.ts";
import { errors } from "~/lib/errors.ts";
import { newId } from "~/lib/ids.ts";

export interface NotificationActor {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface PublicNotification {
  id: string;
  type: string;
  entityType: string | null;
  entityId: string | null;
  isRead: boolean;
  createdAt: string;
  actor: NotificationActor;
}

export interface CreateNotificationInput {
  // Recipient — whose inbox this lands in.
  userId: string;
  // Who triggered it (liker, commenter, follower).
  actorId: string;
  type: string;
  entityType?: string | null;
  entityId?: string | null;
}

export interface ListNotificationsParams {
  unread?: boolean;
  cursor?: string;
  dir: Direction;
  limit: number;
}

// The single emitter. A self-action (recipient === actor) is a no-op so a like
// on your own post never notifies you.
export function createNotification(input: CreateNotificationInput): void {
  if (input.userId === input.actorId) return;
  db.insert(notifications)
    .values({
      id: newId(),
      userId: input.userId,
      actorId: input.actorId,
      type: input.type,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
    })
    .run();
}

const notificationWith = {
  actor: {
    columns: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
    },
  },
} as const;

type HydratedNotification = typeof notifications.$inferSelect & {
  actor: NotificationActor;
};

const toPublicNotification = (row: HydratedNotification): PublicNotification => ({
  id: row.id,
  type: row.type,
  entityType: row.entityType,
  entityId: row.entityId,
  isRead: row.isRead,
  createdAt: row.createdAt,
  actor: row.actor,
});

const tupleLt = (c: Cursor) =>
  or(
    lt(notifications.createdAt, c.createdAt),
    and(eq(notifications.createdAt, c.createdAt), lt(notifications.id, c.id)),
  );
const tupleGt = (c: Cursor) =>
  or(
    gt(notifications.createdAt, c.createdAt),
    and(eq(notifications.createdAt, c.createdAt), gt(notifications.id, c.id)),
  );

export async function listNotifications(
  userId: string,
  params: ListNotificationsParams,
): Promise<Envelope<PublicNotification>> {
  const { unread, cursor, dir, limit } = params;
  const cur = cursor ? decodeCursor(cursor) : null;

  const filters: SQL[] = [eq(notifications.userId, userId)];
  if (unread) filters.push(eq(notifications.isRead, false));
  if (cur) {
    const boundary = dir === "newer" ? tupleGt(cur) : tupleLt(cur);
    if (boundary) filters.push(boundary);
  }

  const orderBy =
    dir === "newer"
      ? [asc(notifications.createdAt), asc(notifications.id)]
      : [desc(notifications.createdAt), desc(notifications.id)];

  const idRows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(...filters))
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = idRows.length > limit;
  const ids = idRows.slice(0, limit).map((r) => r.id);
  if (ids.length === 0) return toEnvelope<PublicNotification>([], false);

  const rows = (await db.query.notifications.findMany({
    where: inArray(notifications.id, ids),
    with: notificationWith,
  })) as HydratedNotification[];

  const byId = new Map(rows.map((r) => [r.id, r]));
  const data = ids.map((id) => toPublicNotification(byId.get(id)!));

  return toEnvelope(data, hasMore);
}

// Flip a single notification to read. 404 when it doesn't exist or isn't the
// caller's — we never reveal another user's inbox by id.
export async function markNotificationRead(
  userId: string,
  id: string,
): Promise<PublicNotification> {
  const existing = db
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(eq(notifications.id, id))
    .get();
  if (!existing || existing.userId !== userId) {
    throw errors.notFound("Notification not found");
  }

  db.update(notifications)
    .set({ isRead: true })
    .where(eq(notifications.id, id))
    .run();

  const row = (await db.query.notifications.findFirst({
    where: eq(notifications.id, id),
    with: notificationWith,
  })) as HydratedNotification;
  return toPublicNotification(row);
}

// Flip every unread notification for the caller. Returns how many it touched.
export async function markAllNotificationsRead(
  userId: string,
): Promise<{ updated: number }> {
  const unreadRows = db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
    )
    .all();

  if (unreadRows.length) {
    db.update(notifications)
      .set({ isRead: true })
      .where(
        and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
      )
      .run();
  }

  return { updated: unreadRows.length };
}

// Notification routes — the caller's private inbox. AUTH throughout. Thin:
// clamp/parse, delegate to the notifications service.

import { Elysia, t } from "elysia";

import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "~/services/notifications.ts";

import { authGuard } from "~/plugins/auth-guard.ts";

const clampLimit = (v?: number): number => {
  if (v === undefined || Number.isNaN(v)) return 20;
  return Math.max(1, Math.min(100, Math.floor(v)));
};

export const notificationRoutes = new Elysia({ prefix: "/api/notifications" })
  .use(authGuard)

  // AUTH — list the caller's notifications, newest-first. ?unread=true filters
  // to the unread ones.
  .get(
    "/",
    ({ user, query }) =>
      listNotifications(user!.id, {
        unread: query.unread === "true",
        cursor: query.cursor,
        dir: query.dir ?? "older",
        limit: clampLimit(query.limit),
      }),
    {
      auth: true,
      query: t.Object({
        unread: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
        dir: t.Optional(t.Union([t.Literal("older"), t.Literal("newer")])),
        limit: t.Optional(t.Numeric()),
      }),
      detail: { summary: "List notifications", tags: ["notifications"] },
    },
  )

  // AUTH — flip every unread notification to read. Declared before /:id/read so
  // the static segment wins.
  .post("/read-all", ({ user }) => markAllNotificationsRead(user!.id), {
    auth: true,
    detail: { summary: "Mark all read", tags: ["notifications"] },
  })

  // AUTH — flip a single notification to read (404 if it isn't yours).
  .post(
    "/:id/read",
    ({ user, params }) => markNotificationRead(user!.id, params.id),
    { auth: true, detail: { summary: "Mark one read", tags: ["notifications"] } },
  );

// The single realtime endpoint. One `/ws` socket per client; the client sends
// control frames ({ action: "subscribe" | "unsubscribe", topic }) and the hub
// pushes JSON events back. Thin by design: parse the frame, check access, hand
// the socket to the hub — every actual event originates in a service mutation.
//
// Access: feed:global, tag:{slug} and post:{id} are public (no session needed to
// upgrade or subscribe). user:{id} is per-user — the access-token cookie is
// verified during the upgrade by authGuard's scoped `derive`, so `ws.data.user`
// is the session at connect time, and you may only subscribe to your *own* topic.

import { Elysia } from "elysia";

import { hub } from "~/lib/realtime.ts";

import { authGuard } from "~/plugins/auth-guard.ts";

// A well-formed client→server control frame. Elysia auto-parses JSON text frames
// into objects, so we just narrow the shape here.
interface ControlFrame {
  action: string;
  topic: string;
}

const isControlFrame = (m: unknown): m is ControlFrame =>
  typeof m === "object" &&
  m !== null &&
  typeof (m as Record<string, unknown>).action === "string" &&
  typeof (m as Record<string, unknown>).topic === "string";

// user:{id} is the only gated topic: it requires a session and the id must be the
// caller's own. Everything else is public.
const maySubscribe = (topic: string, userId: string | null): boolean => {
  if (topic.startsWith("user:")) {
    return userId !== null && topic === `user:${userId}`;
  }
  return true;
};

const send = (ws: { send: (s: string) => unknown }, payload: unknown): void => {
  ws.send(JSON.stringify(payload));
};

export const wsRoutes = new Elysia().use(authGuard).ws("/ws", {
  message(ws, message) {
    // `user` was resolved from the access cookie at upgrade (authGuard derive).
    const user = (ws.data as { user?: { id: string } | null }).user ?? null;
    const userId = user?.id ?? null;

    if (!isControlFrame(message)) {
      send(ws, {
        error: { code: "BAD_FRAME", message: "Expected { action, topic }" },
      });
      return;
    }

    const { action, topic } = message;

    if (action === "subscribe") {
      if (!maySubscribe(topic, userId)) {
        send(ws, {
          error: { code: "FORBIDDEN", message: `Cannot subscribe to ${topic}` },
        });
        return;
      }
      hub.subscribe(topic, ws.raw);
      send(ws, { ok: true, action, topic });
      return;
    }

    if (action === "unsubscribe") {
      hub.unsubscribe(topic, ws.raw);
      send(ws, { ok: true, action, topic });
      return;
    }

    send(ws, {
      error: { code: "BAD_ACTION", message: `Unknown action: ${action}` },
    });
  },

  // Disconnect drops the socket from every topic it joined — no leaks.
  close(ws) {
    hub.cleanup(ws.raw);
  },
});

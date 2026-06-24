// The session guard every authenticated route leans on. It does three things:
//   1. derive `user` — verify the access-token cookie's JWT and load the row, or
//      null. Always runs, so even public routes can tell if someone's logged in.
//   2. .auth() macro — opt a route into "must be signed in": 401 when `user` is
//      null, plus the CSRF check on mutating requests.
//   3. owner() — the ownership guard later write routes call to 403 a caller who
//      doesn't own the row.

import { Elysia } from "elysia";
import { eq } from "drizzle-orm";

import { db } from "~/db/index.ts";
import { users } from "~/db/schema.ts";
import { jwtAccess } from "~/lib/auth.ts";
import { assertCsrf } from "~/lib/csrf.ts";
import { errors } from "~/lib/errors.ts";

// The user shape exposed to clients — every column except password_hash.
export interface PublicUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  isBot: boolean;
  createdAt: string;
  updatedAt: string;
}

type UserRow = typeof users.$inferSelect;

export const toPublicUser = (row: UserRow): PublicUser => ({
  id: row.id,
  username: row.username,
  email: row.email,
  displayName: row.displayName,
  avatarUrl: row.avatarUrl,
  bio: row.bio,
  isBot: row.isBot,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const loadUser = async (id: string): Promise<PublicUser | null> => {
  const row = await db.query.users.findFirst({ where: eq(users.id, id) });
  return row ? toPublicUser(row) : null;
};

// Ownership guard for write/owner routes: 403 unless the row's owner is the caller.
export const assertOwner = (ownerId: string, userId: string): void => {
  if (ownerId !== userId) throw errors.forbidden();
};

export const authGuard = new Elysia({ name: "auth-guard" })
  .use(jwtAccess)
  // Verify the access cookie and attach `user` (or null) to every request in scope.
  .derive({ as: "scoped" }, async ({ jwt, cookie }) => {
    const token = cookie.access_token?.value;
    if (typeof token !== "string" || !token) {
      return { user: null as PublicUser | null };
    }
    const payload = await jwt.verify(token);
    const sub = payload ? payload.sub : undefined;
    if (typeof sub !== "string") return { user: null as PublicUser | null };
    return { user: await loadUser(sub) };
  })
  .macro({
    // `{ auth: true }` on a route → must be signed in. Mutating requests also pass
    // the double-submit CSRF check here.
    auth(enabled: boolean) {
      if (!enabled) return;
      return {
        beforeHandle({ user, request, cookie }: any) {
          if (!user) throw errors.unauthenticated();
          assertCsrf(
            request.method,
            request.headers.get("x-csrf-token"),
            cookie.csrf_token?.value,
          );
        },
      };
    },
  })
  .decorate("owner", assertOwner);

// Auth endpoints. Routes stay thin: validate the body, do the session work, set
// cookies, return the public user. The three issuing flows (register/login/refresh)
// all funnel through issueSession so a session is minted exactly one way.
//
// Cookie scoping does the heavy lifting: the refresh cookie only reaches
// /api/auth/refresh, so refresh reads it from the cookie, while logout — which the
// refresh cookie never reaches — revokes by user id instead.

import { Elysia, t } from "elysia";
import { and, eq, or } from "drizzle-orm";

import { db } from "~/db/index.ts";
import { refreshTokens, users } from "~/db/schema.ts";
import {
  generateCsrfToken,
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  jwtAccess,
  refreshTtlSeconds,
  verifyPassword,
} from "~/lib/auth.ts";
import { clearAuthCookies, setAuthCookies } from "~/lib/cookies.ts";
import { errors } from "~/lib/errors.ts";
import { newId } from "~/lib/ids.ts";

import { authGuard, toPublicUser } from "~/plugins/auth-guard.ts";

const nowIso = (): string => new Date().toISOString();
const refreshExpiryIso = (): string =>
  new Date(Date.now() + refreshTtlSeconds * 1000).toISOString();

// Mint a full session for `userId`: sign the access JWT, store a fresh hashed
// refresh token, mint a CSRF token, and set all three cookies.
const issueSession = async (
  jwt: { sign: (p: { sub: string }) => Promise<string> },
  cookie: any,
  userId: string,
): Promise<void> => {
  const accessToken = await jwt.sign({ sub: userId });
  const refreshToken = generateRefreshToken();
  const csrfToken = generateCsrfToken();

  db.insert(refreshTokens)
    .values({
      id: newId(),
      userId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: refreshExpiryIso(),
    })
    .run();

  setAuthCookies(cookie, { accessToken, refreshToken, csrfToken });
};

const registerBody = t.Object({
  username: t.String({ minLength: 3, maxLength: 32 }),
  email: t.String({ pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" }),
  password: t.String({ minLength: 8, maxLength: 100 }),
  displayName: t.String({ minLength: 1, maxLength: 80 }),
});

const loginBody = t.Object({
  email: t.String({ minLength: 1 }),
  password: t.String({ minLength: 1 }),
});

export const authRoutes = new Elysia({ prefix: "/api/auth" })
  .use(jwtAccess)
  .use(authGuard)

  // PUBLIC — create an account and start a session.
  .post(
    "/register",
    async ({ body, jwt, cookie, set }) => {
      const clash = await db.query.users.findFirst({
        where: or(eq(users.email, body.email), eq(users.username, body.username)),
        columns: { id: true },
      });
      if (clash) throw errors.conflict("Email or username already in use");

      const id = newId();
      const row = {
        id,
        username: body.username,
        email: body.email,
        passwordHash: await hashPassword(body.password),
        displayName: body.displayName,
        avatarUrl: null,
        bio: null,
        isBot: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.insert(users).values(row).run();

      await issueSession(jwt, cookie, id);
      set.status = 201;
      return toPublicUser(row);
    },
    { body: registerBody, detail: { summary: "Register", tags: ["auth"] } },
  )

  // PUBLIC — verify credentials and start a session.
  .post(
    "/login",
    async ({ body, jwt, cookie }) => {
      const user = await db.query.users.findFirst({
        where: eq(users.email, body.email),
      });
      // Same error whether the email is unknown or the password is wrong — don't
      // leak which accounts exist.
      if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
        throw errors.unauthenticated("Invalid credentials");
      }

      await issueSession(jwt, cookie, user.id);
      return toPublicUser(user);
    },
    { body: loginBody, detail: { summary: "Login", tags: ["auth"] } },
  )

  // PUBLIC — rotate: validate the refresh cookie against its stored hash, revoke
  // the old row, issue a brand-new session. The only endpoint the refresh cookie
  // is sent to.
  .post(
    "/refresh",
    async ({ jwt, cookie }) => {
      const raw = cookie.refresh_token?.value;
      if (typeof raw !== "string" || !raw) {
        throw errors.unauthenticated("Missing refresh token");
      }

      const row = await db.query.refreshTokens.findFirst({
        where: and(
          eq(refreshTokens.tokenHash, hashRefreshToken(raw)),
          eq(refreshTokens.revoked, false),
        ),
      });
      if (!row || row.expiresAt <= nowIso()) {
        throw errors.unauthenticated("Invalid refresh token");
      }

      db.update(refreshTokens)
        .set({ revoked: true })
        .where(eq(refreshTokens.id, row.id))
        .run();

      await issueSession(jwt, cookie, row.userId);

      const user = await db.query.users.findFirst({
        where: eq(users.id, row.userId),
      });
      if (!user) throw errors.unauthenticated("Invalid refresh token");
      return toPublicUser(user);
    },
    { detail: { summary: "Refresh session", tags: ["auth"] } },
  )

  // AUTH — revoke every live refresh token for the caller and clear cookies.
  .post(
    "/logout",
    ({ user, cookie }) => {
      db.update(refreshTokens)
        .set({ revoked: true })
        .where(
          and(eq(refreshTokens.userId, user!.id), eq(refreshTokens.revoked, false)),
        )
        .run();
      clearAuthCookies(cookie);
      return { ok: true };
    },
    { auth: true, detail: { summary: "Logout", tags: ["auth"] } },
  )

  // AUTH — the current user.
  .get("/me", ({ user }) => user, {
    auth: true,
    detail: { summary: "Current user", tags: ["auth"] },
  });

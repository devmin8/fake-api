// The three session cookies, set and cleared as a set. Flags follow the design:
//   · access_token  — httpOnly, Path=/                  (sent on every request)
//   · refresh_token — httpOnly, Path=/api/auth/refresh  (scoped to the one
//                     endpoint that consumes it, so it isn't sent everywhere)
//   · csrf_token    — NOT httpOnly, Path=/              (JS reads it to echo the
//                     double-submit header)
// Secure + SameSite=Lax come from config. SameSite=Lax is enough because the app
// and API live on the same parent domain; clearing reuses the matching Path so the
// browser actually drops each cookie.

import type { Cookie } from "elysia";

import { config } from "~/config.ts";
import { accessTtlSeconds, refreshTtlSeconds } from "~/lib/auth.ts";

// Elysia's reactive cookie jar. Names aren't known to a schema here, so the
// context types each value as Cookie<unknown> — we only ever read/write strings.
type CookieJar = Record<string, Cookie<any>>;

// Must match the refresh route's mount path so the cookie attaches there.
const REFRESH_PATH = "/api/auth/refresh";

const base = { secure: config.cookieSecure, sameSite: "lax" as const };

export interface SessionCookies {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
}

export const setAuthCookies = (cookie: CookieJar, s: SessionCookies): void => {
  cookie.access_token.set({
    value: s.accessToken,
    httpOnly: true,
    path: "/",
    maxAge: accessTtlSeconds,
    ...base,
  });
  cookie.refresh_token.set({
    value: s.refreshToken,
    httpOnly: true,
    path: REFRESH_PATH,
    maxAge: refreshTtlSeconds,
    ...base,
  });
  // JS-readable (double-submit). Session cookie — no Max-Age.
  cookie.csrf_token.set({
    value: s.csrfToken,
    httpOnly: false,
    path: "/",
    ...base,
  });
};

// Expire all three (Max-Age=0). Paths mirror setAuthCookies so each one is
// actually removed rather than shadowed.
export const clearAuthCookies = (cookie: CookieJar): void => {
  cookie.access_token.set({ value: "", httpOnly: true, path: "/", maxAge: 0, ...base });
  cookie.refresh_token.set({ value: "", httpOnly: true, path: REFRESH_PATH, maxAge: 0, ...base });
  cookie.csrf_token.set({ value: "", httpOnly: false, path: "/", maxAge: 0, ...base });
};

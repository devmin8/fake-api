// The crypto primitives behind sessions. Two token kinds live here:
//   · access_token — a short-lived JWT ({ sub: userId }), signed/verified by the
//     @elysiajs/jwt plugin (exported configured, so routes and the guard share one
//     instance). The JWT is only the access-token *format*; it travels in an
//     httpOnly cookie, never readable by JS.
//   · refresh_token — an opaque random string. We never store it; we store its
//     SHA-256 hash and compare hashes on refresh. (Argon2 is for low-entropy
//     passwords; a 256-bit random token needs only a fast one-way hash.)
// Passwords go through Bun.password (argon2id) — the same hasher the seed used,
// so the seeded test user verifies here.

import { jwt } from "@elysiajs/jwt";
import { createHash, randomBytes } from "node:crypto";

import { config } from "~/config.ts";

// Configured access-token JWT plugin. `exp` defaults every signed token to the
// access TTL; payload carries only { sub: userId }. Named "jwt" so the context
// gains `jwt.sign` / `jwt.verify`.
export const jwtAccess = jwt({
  name: "jwt",
  secret: config.jwtSecret,
  exp: config.accessTokenTtl,
});

// --- passwords (argon2id, built into Bun) ---

export const hashPassword = (plain: string): Promise<string> =>
  Bun.password.hash(plain);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  Bun.password.verify(plain, hash);

// --- opaque tokens (refresh + CSRF) ---

// The raw refresh token handed to the client (in the refresh cookie). 256 bits.
export const generateRefreshToken = (): string => randomBytes(32).toString("hex");

// The CSRF token (double-submit). Lower entropy is fine — it's not a secret,
// just an unguessable value echoed back in a header.
export const generateCsrfToken = (): string => randomBytes(16).toString("hex");

// What we actually persist in refresh_tokens.token_hash.
export const hashRefreshToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

// --- durations ---

// Turn a "15m" / "7d" style TTL into seconds (for cookie Max-Age and the refresh
// row's expiry). Falls back to treating a bare number as seconds.
export const parseDurationSeconds = (spec: string): number => {
  const m = /^(\d+)\s*([smhd])$/.exec(spec.trim());
  if (!m) {
    const n = Number(spec);
    return Number.isFinite(n) ? n : 0;
  }
  const value = Number(m[1]);
  const unit = m[2];
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return value * mult;
};

export const accessTtlSeconds = parseDurationSeconds(config.accessTokenTtl);
export const refreshTtlSeconds = parseDurationSeconds(config.refreshTokenTtl);

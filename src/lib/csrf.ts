// Double-submit CSRF check. The client reads the JS-readable csrf_token cookie and
// echoes it in an X-CSRF-Token header on every mutating request; we confirm the two
// match. A forged cross-site request can ride the cookie but can't read it to set
// the header, so it fails here. Gated by CSRF_ENABLED so the handshake can be
// switched off while focusing on a frontend (see bruno-testing-plan).

import { config } from "~/config.ts";
import { errors } from "~/lib/errors.ts";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Throws FORBIDDEN when the header is missing or doesn't match the cookie. No-op
// for safe methods (GET/HEAD) and when CSRF is disabled.
export const assertCsrf = (
  method: string,
  headerToken: string | null,
  cookieToken: string | undefined,
): void => {
  if (!config.csrfEnabled) return;
  if (!MUTATING.has(method.toUpperCase())) return;
  if (!cookieToken || !headerToken || headerToken !== cookieToken) {
    throw errors.forbidden("CSRF token missing or invalid");
  }
};

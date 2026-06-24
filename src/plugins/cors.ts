// Credentialed CORS for a single trusted origin.
//
// Cookie auth requires Access-Control-Allow-Credentials: true, and the spec
// forbids pairing that with a wildcard origin. So we echo the exact configured
// origin (only when the request's Origin matches) and never emit "*".

import { Elysia } from "elysia";

import { config } from "~/config.ts";

const ALLOW_METHODS = "GET,POST,PATCH,PUT,DELETE,OPTIONS";
const ALLOW_HEADERS = "Content-Type,X-CSRF-Token";

export const cors = new Elysia({ name: "cors" })
  .onRequest(({ request, set }) => {
    const origin = request.headers.get("origin");
    if (origin && origin === config.corsOrigin) {
      set.headers["access-control-allow-origin"] = origin;
      set.headers["access-control-allow-credentials"] = "true";
      set.headers["vary"] = "Origin";
    }

    // Short-circuit the preflight with the full allow-set.
    if (request.method === "OPTIONS") {
      set.headers["access-control-allow-methods"] = ALLOW_METHODS;
      set.headers["access-control-allow-headers"] = ALLOW_HEADERS;
      set.headers["access-control-max-age"] = "86400";
      set.status = 204;
      return "";
    }
  });

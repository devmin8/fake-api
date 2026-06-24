// fake-api entry point.
// Mounts plugins (CORS, Swagger), the global error envelope, the routes, and the
// realtime WS endpoint. A later ticket adds the firehose simulator here.

import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";

import { config } from "~/config.ts";
import { runMigrations } from "~/db/migrate.ts";
import { cors } from "~/plugins/cors.ts";
import { ApiError, type ErrorEnvelope } from "~/lib/errors.ts";
import { authRoutes } from "~/routes/auth.ts";
import {
  commentRoutes,
  postCommentRoutes,
} from "~/routes/comments.ts";
import { postRoutes } from "~/routes/posts.ts";
import { bookmarkRoutes } from "~/routes/bookmarks.ts";
import { feedRoutes } from "~/routes/feed.ts";
import { notificationRoutes } from "~/routes/notifications.ts";
import { tagRoutes } from "~/routes/tags.ts";
import { userRoutes } from "~/routes/users.ts";
import { wsRoutes } from "~/routes/ws.ts";

// Bring the schema up to date before serving — a fresh checkout boots straight
// into a fully-tabled ./data/app.db with no manual migrate step.
runMigrations();

const app = new Elysia()
  .use(cors)
  .use(
    swagger({
      path: "/docs",
      documentation: {
        info: {
          title: "fake-api",
          version: "0.1.0",
          description:
            "Self-hosted relational + realtime mock backend (Bun · Elysia).",
        },
      },
    }),
  )
  // Global error envelope: every thrown/unknown error becomes
  // { error: { code, message, details? } } — never a raw stack.
  .onError(({ code, error, set }) => {
    if (error instanceof ApiError) {
      set.status = error.status;
      return error.toEnvelope();
    }

    // Elysia's built-in validation failures.
    if (code === "VALIDATION") {
      set.status = 422;
      const envelope: ErrorEnvelope = {
        error: { code: "VALIDATION_ERROR", message: error.message },
      };
      return envelope;
    }

    if (code === "NOT_FOUND") {
      set.status = 404;
      const envelope: ErrorEnvelope = {
        error: { code: "NOT_FOUND", message: "Not found" },
      };
      return envelope;
    }

    set.status = 500;
    const envelope: ErrorEnvelope = {
      error: { code: "INTERNAL", message: "Internal server error" },
    };
    return envelope;
  })
  .get("/health", () => ({ status: "ok" }), {
    detail: { summary: "Liveness probe", tags: ["meta"] },
  })
  .use(authRoutes)
  .use(postRoutes.use(postCommentRoutes))
  .use(commentRoutes)
  .use(userRoutes)
  .use(tagRoutes)
  .use(bookmarkRoutes)
  .use(feedRoutes)
  .use(notificationRoutes)
  .use(wsRoutes)
  .listen(config.port);

console.log(
  `🚀 fake-api listening on http://${app.server?.hostname}:${app.server?.port}` +
    `  ·  docs at /docs`,
);

export type App = typeof app;

// Firehose control surface — public, and mounted only when SIM_CONTROL_ENABLED
// (the gate lives in index.ts, so when it's off these routes don't exist at all
// and hit the global 404). Thin: validate the patch, delegate to the firehose
// singleton, return its current status. The simulator itself drives the services.

import { Elysia, t } from "elysia";

import { firehose } from "~/sim/firehose.ts";

export const simRoutes = new Elysia({ prefix: "/api/sim" })
  // Running state + live config — the one read endpoint.
  .get("/status", () => firehose.status(), {
    detail: { summary: "Simulator status", tags: ["sim"] },
  })

  // Start / stop are idempotent toggles; both return the resulting status.
  .post("/start", () => {
    firehose.start();
    return firehose.status();
  }, { detail: { summary: "Start the simulator", tags: ["sim"] } })

  .post("/stop", () => {
    firehose.stop();
    return firehose.status();
  }, { detail: { summary: "Stop the simulator", tags: ["sim"] } })

  // Patch cadence / actions-per-tick / weights live. All fields optional; an
  // interval change re-arms a running timer immediately.
  .patch(
    "/config",
    ({ body }) => firehose.configure(body),
    {
      body: t.Object({
        intervalMs: t.Optional(t.Integer({ minimum: 50 })),
        actionsPerTick: t.Optional(t.Integer({ minimum: 1 })),
        weights: t.Optional(
          t.Object({
            createPost: t.Optional(t.Number({ minimum: 0 })),
            comment: t.Optional(t.Number({ minimum: 0 })),
            likePost: t.Optional(t.Number({ minimum: 0 })),
            likeCommentOrFollow: t.Optional(t.Number({ minimum: 0 })),
          }),
        ),
      }),
      detail: { summary: "Patch simulator config", tags: ["sim"] },
    },
  );

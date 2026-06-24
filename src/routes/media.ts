// Media routes. Upload is AUTH (multipart); serving is PUBLIC. Thin throughout:
// validate the multipart shape, delegate to the media service — the service owns
// the mime/size checks and every filesystem + DB write.

import { Elysia, t } from "elysia";

import { saveMedia, serveMedia } from "~/services/media.ts";

import { authGuard } from "~/plugins/auth-guard.ts";

export const mediaRoutes = new Elysia({ prefix: "/api/media" })
  .use(authGuard)

  // AUTH — multipart upload; returns { url } usable as a post's image_url. The
  // body schema only asserts a file is present; the service enforces images-only
  // mime + max size (422 on either).
  .post(
    "/",
    ({ user, body, set }) => {
      set.status = 201;
      return saveMedia(user!.id, body.file);
    },
    {
      auth: true,
      body: t.Object({ file: t.File() }),
      detail: { summary: "Upload media", tags: ["media"] },
    },
  )

  // PUBLIC — serve a stored file with its recorded content-type. Unknown
  // filename → 404 (the lookup also blocks path traversal).
  .get(
    "/:file",
    async ({ params }) => {
      const { mime, file } = await serveMedia(params.file);
      return new Response(file, { headers: { "content-type": mime } });
    },
    { detail: { summary: "Serve media", tags: ["media"] } },
  );

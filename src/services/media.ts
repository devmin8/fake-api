// Media uploads — the one write path for stored files. The route hands us a
// validated `File` off a multipart request; we enforce images-only mime + a max
// size, write the bytes under config.uploadDir as <ulid>.<ext>, record a `media`
// row, and return a `{ url }` a client can drop straight into a post's
// `image_url`. Serving reads the row back so the content-type is whatever we
// stored, and a filename can't escape the upload dir (no row → 404).

import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { eq } from "drizzle-orm";

import { config } from "~/config.ts";
import { db } from "~/db/index.ts";
import { media } from "~/db/schema.ts";
import { errors } from "~/lib/errors.ts";
import { newId } from "~/lib/ids.ts";

// Allow-list of image mimes → on-disk extension. Anything not here is rejected,
// which is also what keeps the upload dir to known, safe extensions.
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Ensure the upload dir exists once at module load — same first-run-friendly
// posture as db/index.ts creating the DB's parent dir.
mkdirSync(config.uploadDir, { recursive: true });

export interface SavedMedia {
  id: string;
  url: string;
  mime: string;
  filename: string;
}

export async function saveMedia(
  ownerId: string,
  file: File,
): Promise<SavedMedia> {
  const mime = file.type;
  const ext = EXT_BY_MIME[mime];
  if (!ext) {
    throw errors.validation(
      `Unsupported media type "${mime || "unknown"}" — images only`,
    );
  }
  if (file.size === 0) {
    throw errors.validation("Empty upload");
  }
  if (file.size > config.mediaMaxBytes) {
    throw errors.validation(
      `File too large — max ${config.mediaMaxBytes} bytes`,
    );
  }

  const id = newId();
  const filename = `${id}.${ext}`;
  const url = `/api/media/${filename}`;

  await Bun.write(join(config.uploadDir, filename), file);
  db.insert(media).values({ id, ownerId, filename, mime, url }).run();

  return { id, url, mime, filename };
}

export interface ServedMedia {
  mime: string;
  file: ReturnType<typeof Bun.file>;
}

// Resolve a stored file for serving. We look the row up by filename rather than
// touching the filesystem with the raw param, so a `../`-style path can't escape
// the upload dir — an unknown filename is simply a 404.
export async function serveMedia(filename: string): Promise<ServedMedia> {
  const row = db
    .select({ mime: media.mime })
    .from(media)
    .where(eq(media.filename, filename))
    .get();
  if (!row) throw errors.notFound("Media not found");

  const file = Bun.file(join(config.uploadDir, filename));
  if (!(await file.exists())) throw errors.notFound("Media not found");

  return { mime: row.mime, file };
}

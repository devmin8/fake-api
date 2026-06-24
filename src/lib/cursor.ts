// Opaque directional cursor + the collection-response envelope.
//
// A cursor is the base64 of `created_at|id` — a stable boundary over the
// (created_at, id) tuple. Because ULIDs and ISO timestamps both sort lexically,
// that tuple is a total order on rows by real creation time, so a cursor
// anchored to a row the client already holds never drifts when newer rows
// arrive at the head. That single property is what lets a live feed paginate
// without gaps or dupes (see the design's Pagination conventions).

import { errors } from "~/lib/errors.ts";

export interface Cursor {
  createdAt: string;
  id: string;
}

export type Direction = "older" | "newer";

export interface Envelope<T> {
  data: T[];
  newestCursor: string | null;
  oldestCursor: string | null;
  hasMore: boolean;
}

// `created_at|id` → base64. A ULID is Crockford base32 (no pipe), so the first
// pipe is an unambiguous split point.
export const encodeCursor = (createdAt: string, id: string): string =>
  Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64");

export const decodeCursor = (raw: string): Cursor => {
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  const sep = decoded.indexOf("|");
  if (sep <= 0 || sep === decoded.length - 1) {
    throw errors.validation("Malformed cursor");
  }
  return { createdAt: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
};

// Build the collection envelope from a page already in display order.
//   - chronological sorts: the bounds are the newest/oldest rows by time, so
//     the client can stitch the next page off either edge (older or newer).
//   - ranked sorts (top/trending): the bounds are the first/last rows in rank
//     order — `oldestCursor` is the continuation anchor for the older-only scroll.
export const toEnvelope = <T extends Cursor>(
  data: T[],
  hasMore: boolean,
  opts: { ranked?: boolean } = {},
): Envelope<T> => {
  if (data.length === 0) {
    return { data, newestCursor: null, oldestCursor: null, hasMore: false };
  }

  let newest = data[0]!;
  let oldest = data[0]!;
  if (opts.ranked) {
    oldest = data[data.length - 1]!;
  } else {
    const key = (r: Cursor) => `${r.createdAt}|${r.id}`;
    for (const row of data) {
      if (key(row) > key(newest)) newest = row;
      if (key(row) < key(oldest)) oldest = row;
    }
  }

  return {
    data,
    newestCursor: encodeCursor(newest.createdAt, newest.id),
    oldestCursor: encodeCursor(oldest.createdAt, oldest.id),
    hasMore,
  };
};

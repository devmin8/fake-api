// Route-layer pagination helpers — the one place the (cursor, dir, limit)
// contract lives. Every paginated GET clamps its limit, validates the same
// query shape, and normalizes `dir` to "older" the same way; keeping that here
// stops the seven route modules from each carrying their own copy and drifting.

import { t } from "elysia";

import type { Direction } from "~/lib/cursor.ts";

// default 20, max 100, min 1 — non-numeric/absent falls back to the default.
export const clampLimit = (v?: number): number => {
  if (v === undefined || Number.isNaN(v)) return 20;
  return Math.max(1, Math.min(100, Math.floor(v)));
};

// The (cursor, dir, limit) query shared by every paginated list endpoint.
export const listQuery = t.Object({
  cursor: t.Optional(t.String()),
  dir: t.Optional(t.Union([t.Literal("older"), t.Literal("newer")])),
  limit: t.Optional(t.Numeric()),
});

// The raw, still-optional query as Elysia hands it to a handler.
export interface ListQuery {
  cursor?: string;
  dir?: Direction;
  limit?: number;
}

// The normalized params a list service expects: dir defaulted, limit clamped.
export interface ListParams {
  cursor?: string;
  dir: Direction;
  limit: number;
}

// Normalize a raw list query into service params — dir defaults to "older",
// limit is clamped to [1, 100] (default 20).
export const listParams = (query: ListQuery): ListParams => ({
  cursor: query.cursor,
  dir: query.dir ?? "older",
  limit: clampLimit(query.limit),
});

// A GET handler for the `/:key/...` list endpoints (e.g. /:id/comments,
// /:username/posts): pulls the path param named `key` and the normalized list
// query, then hands both to the service `fn`.
export const listHandler =
  <K extends string>(
    key: K,
    fn: (id: string, params: ListParams) => unknown,
  ) =>
  ({ params, query }: { params: Record<K, string>; query: ListQuery }) =>
    fn(params[key], listParams(query));

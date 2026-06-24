// ULID primary keys. Time-sortable, so a fresh row's id is always lexically
// greater than older ones — that property is what lets ids double as stable
// pagination cursors (see lib/cursor.ts) without a separate sort column.

import { ulid } from "ulid";

// A new ULID for "now". Pass an explicit time only when backdating seed/sim rows.
export const newId = (seedTime?: number): string => ulid(seedTime);

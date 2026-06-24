// Apply pending Drizzle migrations from ./drizzle. Called once on boot from
// index.ts so a fresh ./data/app.db is created with every table, and also
// runnable standalone via `bun run db:migrate`.

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { db, sqlite } from "./index.ts";

export function runMigrations(): void {
  migrate(db, { migrationsFolder: "./drizzle" });
}

// `bun run src/db/migrate.ts` → apply and exit (used by the db:migrate script).
if (import.meta.main) {
  runMigrations();
  sqlite.close();
  console.log("✅ migrations applied");
}

// drizzle-kit config: where the schema lives and where generated SQL migrations
// go. `bun run db:generate` diffs schema.ts against ./drizzle and writes the next
// migration; `db:migrate` applies them (see src/db/migrate.ts).

import { defineConfig } from "drizzle-kit";

import { config } from "~/config.ts";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: config.dbPath },
});

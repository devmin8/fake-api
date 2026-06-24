// bun:sqlite connection + Drizzle client. The DB file lives at config.dbPath
// (DB_PATH, default ./data/app.db); we create its parent dir on first open so a
// fresh checkout boots without manual setup. foreign_keys is OFF by default in
// SQLite — we turn it ON so the cascades/constraints in schema.ts are enforced.

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { config } from "~/config.ts";

import * as schema from "./schema.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const sqlite = new Database(config.dbPath, { create: true });
sqlite.exec("PRAGMA foreign_keys = ON;");
sqlite.exec("PRAGMA journal_mode = WAL;");

export const db = drizzle(sqlite, { schema });

export type DB = typeof db;

import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { config } from "../config.ts";
import * as schema from "./schema.ts";

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.workspacesDir, { recursive: true });
mkdirSync(config.agentDataDir, { recursive: true });

export const sqlite = new Database(config.dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export { schema };

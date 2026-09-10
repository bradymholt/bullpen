import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./index.ts";

const migrationsFolder = resolve(import.meta.dirname, "../../drizzle");

export function runMigrations(): void {
  if (!existsSync(migrationsFolder)) {
    throw new Error(`No migrations at ${migrationsFolder} — run \`npm run db:generate -w @bullpen/server\``);
  }
  migrate(db, { migrationsFolder });
}

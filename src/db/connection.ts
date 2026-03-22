import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbDir = join(process.cwd(), "data");
  mkdirSync(dbDir, { recursive: true });

  const dbPath = join(dbDir, "whoop-mcp.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  return db;
}

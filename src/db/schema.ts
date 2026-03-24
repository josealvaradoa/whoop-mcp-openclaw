import type Database from "better-sqlite3";

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      scope TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      cached_at INTEGER NOT NULL DEFAULT (unixepoch()),
      ttl_seconds INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_clients (
      client_id TEXT PRIMARY KEY,
      client_info TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_access_tokens (
      token TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_refresh_tokens (
      token TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
}

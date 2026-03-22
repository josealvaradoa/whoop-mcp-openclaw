import { getDb } from "./connection.js";

export function get(key: string): unknown | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM cache WHERE key = ? AND cached_at + ttl_seconds > unixepoch()")
    .get(key) as { value: string } | undefined;

  return row ? JSON.parse(row.value) : null;
}

export function set(key: string, value: unknown, ttlSeconds: number): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO cache (key, value, cached_at, ttl_seconds) VALUES (?, ?, unixepoch(), ?)"
  ).run(key, JSON.stringify(value), ttlSeconds);
}

export function invalidate(keyPrefix: string): void {
  const db = getDb();
  db.prepare("DELETE FROM cache WHERE key LIKE ?").run(keyPrefix + "%");
}

export function cleanup(): void {
  const db = getDb();
  db.prepare("DELETE FROM cache WHERE cached_at + ttl_seconds < unixepoch()").run();
}

export function startCacheCleanupInterval(): void {
  cleanup();
  setInterval(cleanup, 30 * 60 * 1000);
}

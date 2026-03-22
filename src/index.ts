import { config } from "./config.js";
import { getDb } from "./db/connection.js";
import { initSchema } from "./db/schema.js";
import { startCacheCleanupInterval } from "./db/cache.js";
import { createApp } from "./server.js";

// Initialize database
const db = getDb();
initSchema(db);
startCacheCleanupInterval();

// Start server
const app = createApp();
app.listen(config.server.port, () => {
  console.log(`whoop-ironman-mcp running on port ${config.server.port}`);
});

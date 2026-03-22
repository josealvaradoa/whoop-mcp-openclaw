import { config } from "./config.js";
import { getDb } from "./db/connection.js";
import { initSchema } from "./db/schema.js";
import { startCacheCleanupInterval } from "./db/cache.js";
import { createApp } from "./server.js";
import { mountMcp } from "./mcp/setup.js";

// Initialize database
const db = getDb();
initSchema(db);
startCacheCleanupInterval();

// Start Express server with MCP routes
const app = createApp();
mountMcp(app);

app.listen(config.server.port, () => {
  console.log(`whoop-ironman-mcp running on port ${config.server.port}`);
});

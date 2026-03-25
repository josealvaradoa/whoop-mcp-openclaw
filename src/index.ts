import { config } from "./config.js";
import { getDb } from "./db/connection.js";
import { initSchema } from "./db/schema.js";
import { startCacheCleanupInterval } from "./db/cache.js";
import { createApp, oauthProvider } from "./server.js";
import { mountMcp } from "./mcp/setup.js";
import logger from "./logger.js";

// Initialize database
const db = getDb();
initSchema(db);
startCacheCleanupInterval();

// Start Express server with MCP routes
const app = createApp();
mountMcp(app, oauthProvider);

app.listen(config.server.port, () => {
  logger.info({ port: config.server.port }, "whoop-ironman-mcp running");
});

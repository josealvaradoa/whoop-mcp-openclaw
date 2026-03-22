import { config } from "./config.js";
import { getDb } from "./db/connection.js";
import { initSchema } from "./db/schema.js";
import { startCacheCleanupInterval } from "./db/cache.js";
import { createApp } from "./server.js";
import { createMcpServer, registerTools, mountMcp } from "./mcp/setup.js";

// Initialize database
const db = getDb();
initSchema(db);
startCacheCleanupInterval();

// Initialize MCP server
const mcpServer = createMcpServer();
registerTools(mcpServer);

// Start Express server with MCP routes
const app = createApp();
mountMcp(app, mcpServer);

app.listen(config.server.port, () => {
  console.log(`whoop-ironman-mcp running on port ${config.server.port}`);
});

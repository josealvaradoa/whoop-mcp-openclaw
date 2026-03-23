import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { registerOverviewTool } from "./tools/overview.js";
import { registerRecoveryTool } from "./tools/recovery.js";
import { registerHrvTool } from "./tools/hrv.js";
import { registerSleepTool } from "./tools/sleep.js";
import { registerTrainingLoadTool } from "./tools/training-load.js";
import { registerWorkoutsTool } from "./tools/workouts.js";
import { registerRaceReadinessTool } from "./tools/race-readiness.js";

const MAX_SESSIONS = 10;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "whoop-ironman-mcp",
    version: "1.0.0",
  });

  registerOverviewTool(server);
  registerRecoveryTool(server);
  registerHrvTool(server);
  registerSleepTool(server);
  registerTrainingLoadTool(server);
  registerWorkoutsTool(server);
  registerRaceReadinessTool(server);

  return server;
}

function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((m: { method?: string }) => m.method === "initialize");
  }
  return (body as { method?: string })?.method === "initialize";
}

export function mountMcp(app: Express, provider: OAuthServerProvider): void {
  const auth = requireBearerAuth({ verifier: provider });
  const sessions = new Map<string, Session>();

  // Evict expired sessions every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
        console.log(`Session ${id} timed out, closing`);
        session.transport.close();
        session.server.close();
        sessions.delete(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  async function evictOldest(): Promise<void> {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, session] of sessions) {
      if (session.lastActivity < oldestTime) {
        oldestTime = session.lastActivity;
        oldestId = id;
      }
    }
    if (oldestId) {
      const old = sessions.get(oldestId)!;
      console.log(`Evicting oldest session ${oldestId}`);
      await old.transport.close();
      await old.server.close();
      sessions.delete(oldestId);
    }
  }

  // POST /mcp — JSON-RPC requests
  app.post("/mcp", auth, async (req: Request, res: Response) => {
    try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Route to existing session
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // Only initialize requests can create new sessions
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session. Send an initialize request first.",
        },
        id: null,
      });
      return;
    }

    // Enforce session cap with LRU eviction
    if (sessions.size >= MAX_SESSIONS) {
      await evictOldest();
    }

    // Create new session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const mcpServer = createMcpServer();

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);

    // Session ID is assigned during handleRequest (on initialize)
    if (transport.sessionId) {
      sessions.set(transport.sessionId, {
        transport,
        server: mcpServer,
        lastActivity: Date.now(),
      });
      console.log(`New MCP session: ${transport.sessionId} (active: ${sessions.size})`);
    }
    } catch (err) {
      console.error("POST /mcp error:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(err) }, id: null });
      }
    }
  });

  // GET /mcp — SSE stream for server-to-client notifications
  app.get("/mcp", auth, async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({ error: "Invalid or missing session ID" });
        return;
      }
      const session = sessions.get(sessionId)!;
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res);
    } catch (err) {
      console.error("GET /mcp error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: String(err) });
      }
    }
  });

  // DELETE /mcp — close a session
  app.delete("/mcp", auth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const session = sessions.get(sessionId)!;
    await session.transport.close();
    await session.server.close();
    sessions.delete(sessionId);
    console.log(`Session ${sessionId} closed (active: ${sessions.size})`);
    res.status(200).json({ status: "session closed" });
  });
}

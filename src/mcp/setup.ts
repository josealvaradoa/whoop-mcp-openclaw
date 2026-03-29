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
import logger from "../logger.js";

const log = logger.child({ component: "mcp" });

const MAX_SESSIONS = 10;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DRAIN_GRACE_MS = 5_000; // grace period before closing an evicted/timed-out session

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "whoop-mcp-server",
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

/**
 * Drain a session: remove it from the active map immediately (so no new
 * requests are routed to it), then close transport + server after a grace
 * period to allow any in-flight requests to complete.
 */
function drainSession(id: string, session: Session, sessions: Map<string, Session>): void {
  sessions.delete(id);
  setTimeout(() => {
    void session.transport.close();
    void session.server.close();
    log.info({ sessionId: id }, "Session closed after drain");
  }, DRAIN_GRACE_MS);
}

export function mountMcp(app: Express, provider: OAuthServerProvider): void {
  const auth = requireBearerAuth({ verifier: provider });
  const sessions = new Map<string, Session>();

  // Evict timed-out sessions every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
        log.info({ sessionId: id }, "Session timed out — draining");
        drainSession(id, session, sessions);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  function evictOldest(): void {
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
      log.info({ sessionId: oldestId }, "Evicting oldest session — draining");
      drainSession(oldestId, old, sessions);
    }
  }

  // POST /mcp — JSON-RPC requests
  app.post("/mcp", auth, async (req: Request, res: Response) => {
    try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const method = (req.body as { method?: string })?.method ?? (Array.isArray(req.body) ? "batch" : "unknown");
    log.info({ sessionId: sessionId?.slice(0, 8) ?? "none", method, activeSessions: sessions.size }, "POST /mcp");

    // Route to existing session
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // Stale/unknown session ID → 404 per MCP Streamable HTTP spec
    if (sessionId && !sessions.has(sessionId)) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      });
      return;
    }

    // No session ID + not an initialize request → 400
    if (!isInitializeRequest(req.body)) {
      log.error({ sessionId: sessionId ? `${sessionId.slice(0, 8)}…` : "missing", method }, "REJECTED — not initialize");
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

    // Enforce session cap with LRU eviction (drains before creating new session)
    if (sessions.size >= MAX_SESSIONS) {
      evictOldest();
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
      log.info({ sessionId: transport.sessionId, activeSessions: sessions.size }, "New MCP session");
    }
    } catch (err) {
      log.error({ err }, "POST /mcp error");
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
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const session = sessions.get(sessionId)!;
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res);
    } catch (err) {
      log.error({ err }, "GET /mcp error");
      if (!res.headersSent) {
        res.status(500).json({ error: String(err) });
      }
    }
  });

  // DELETE /mcp — close a session
  app.delete("/mcp", auth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const session = sessions.get(sessionId)!;
    await session.transport.close();
    await session.server.close();
    sessions.delete(sessionId);
    log.info({ sessionId, activeSessions: sessions.size }, "Session closed");
    res.status(200).json({ status: "session closed" });
  });
}

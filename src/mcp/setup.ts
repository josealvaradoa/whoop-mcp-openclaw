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
import { logger } from "../logger.js";

const MAX_SESSIONS = 10;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
/** How long to wait for in-flight requests to drain before force-closing. */
const DRAIN_TIMEOUT_MS = 10_000;

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
  /** Number of requests currently being handled by this session. */
  inFlight: number;
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
 * Drains in-flight requests for a session before closing its transport/server.
 * Waits up to DRAIN_TIMEOUT_MS, then force-closes.
 */
async function drainAndClose(id: string, session: Session): Promise<void> {
  if (session.inFlight > 0) {
    logger.info({ sessionId: id.slice(0, 8), inFlight: session.inFlight }, "session draining in-flight requests");
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    await new Promise<void>((resolve) => {
      const check = () => {
        if (session.inFlight <= 0 || Date.now() >= deadline) {
          if (session.inFlight > 0) {
            logger.warn({ sessionId: id.slice(0, 8), inFlight: session.inFlight }, "session drain timed out, force-closing");
          }
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }
  await session.transport.close();
  await session.server.close();
}

export function mountMcp(app: Express, provider: OAuthServerProvider): void {
  const auth = requireBearerAuth({ verifier: provider });
  const sessions = new Map<string, Session>();

  // Evict expired sessions every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
        logger.info({ sessionId: id.slice(0, 8) }, "session timed out, closing");
        sessions.delete(id);
        void drainAndClose(id, session);
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
      logger.info({ sessionId: oldestId.slice(0, 8) }, "evicting oldest session");
      sessions.delete(oldestId);
      await drainAndClose(oldestId, old);
    }
  }

  // POST /mcp — JSON-RPC requests
  app.post("/mcp", auth, async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const method = (req.body as { method?: string })?.method ?? (Array.isArray(req.body) ? "batch" : "unknown");
      logger.debug({ sessionId: sessionId?.slice(0, 8) ?? "none", method, active: sessions.size }, "POST /mcp");

      // Route to existing session
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.lastActivity = Date.now();
        session.inFlight++;
        try {
          await session.transport.handleRequest(req, res, req.body);
        } finally {
          session.inFlight--;
        }
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
        logger.error({ sessionId: sessionId ? `${sessionId.slice(0, 8)}… NOT FOUND` : "missing", method }, "POST /mcp rejected");
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
          inFlight: 0,
        });
        logger.info({ sessionId: transport.sessionId, active: sessions.size }, "new MCP session");
      }
    } catch (err) {
      logger.error({ err }, "POST /mcp error");
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
      logger.error({ err }, "GET /mcp error");
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
    sessions.delete(sessionId);
    await drainAndClose(sessionId, session);
    logger.info({ sessionId: sessionId.slice(0, 8), active: sessions.size }, "session closed");
    res.status(200).json({ status: "session closed" });
  });
}

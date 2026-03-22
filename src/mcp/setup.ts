import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { bearerAuth } from "../server.js";

export function createMcpServer(): McpServer {
  return new McpServer({
    name: "whoop-ironman-mcp",
    version: "1.0.0",
  });
}

export function registerTools(_server: McpServer): void {
  // Tools registered in Phase 6
}

export function mountMcp(app: Express, mcpServer: McpServer): void {
  // Map to track transports by session ID
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // POST /mcp - handle JSON-RPC requests (including initialization)
  app.post("/mcp", bearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Existing session
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — create transport and connect
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };

    await mcpServer.connect(transport);

    if (transport.sessionId) {
      transports.set(transport.sessionId, transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  // GET /mcp - SSE stream for server-to-client notifications
  app.get("/mcp", bearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // DELETE /mcp - close session
  app.delete("/mcp", bearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.close();
    transports.delete(sessionId);
    res.status(200).json({ status: "session closed" });
  });
}

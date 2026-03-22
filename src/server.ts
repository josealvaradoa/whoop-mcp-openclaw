import express from "express";
import type { Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { buildAuthUrl, exchangeCodeForTokens, getTokens } from "./whoop/auth.js";

// OAuth state store: state -> creation timestamp
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cleanupStates(): void {
  const now = Date.now();
  for (const [state, created] of pendingStates) {
    if (now - created > STATE_TTL_MS) {
      pendingStates.delete(state);
    }
  }
}

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== config.security.mcpBearerToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

export function createApp(): express.Express {
  const app = express();

  // CORS — allow MCP Inspector and other browser clients
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (_req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json());

  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // Auth status
  app.get("/auth/status", (_req: Request, res: Response) => {
    const tokens = getTokens();
    if (!tokens) {
      res.json({ authenticated: false });
      return;
    }
    res.json({
      authenticated: true,
      expires_at: new Date(tokens.expiresAt * 1000).toISOString(),
      scopes: tokens.scope,
    });
  });

  // Start OAuth flow
  app.get("/auth/whoop", (_req: Request, res: Response) => {
    cleanupStates();
    const state = randomBytes(16).toString("hex");
    pendingStates.set(state, Date.now());
    res.redirect(buildAuthUrl(state));
  });

  // OAuth callback
  app.get("/auth/whoop/callback", async (req: Request, res: Response) => {
    const { code, state } = req.query;

    if (!state || typeof state !== "string" || !pendingStates.has(state)) {
      res.status(400).send("Invalid or expired state parameter");
      return;
    }
    pendingStates.delete(state);

    if (!code || typeof code !== "string") {
      res.status(400).send("Missing authorization code");
      return;
    }

    try {
      await exchangeCodeForTokens(code);
      res.send(`
        <!DOCTYPE html>
        <html><body style="font-family:system-ui;text-align:center;padding:4rem">
          <h1>Connected!</h1>
          <p>Your Whoop account is linked. You can close this tab.</p>
        </body></html>
      `);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).send(`Authorization failed: ${message}`);
    }
  });

  return app;
}

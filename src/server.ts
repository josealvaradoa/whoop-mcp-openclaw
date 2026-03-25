import express from "express";
import type { Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { config } from "./config.js";
import { buildAuthUrl, exchangeCodeForTokens, getTokens } from "./whoop/auth.js";
import { getDb } from "./db/connection.js";
import logger from "./logger.js";

const log = logger.child({ component: "auth" });

// --- Whoop OAuth state store (SQLite-backed) ---
const STATE_TTL_MS = 10 * 60 * 1000;

interface PendingMcpAuth {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  createdAt: number;
}

function dbAddPendingState(state: string): void {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO oauth_pending_states (state, created_at_ms) VALUES (?, ?)")
    .run(state, Date.now());
}

function dbHasPendingState(state: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM oauth_pending_states WHERE state = ?").get(state);
  return row !== undefined;
}

function dbDeletePendingState(state: string): void {
  const db = getDb();
  db.prepare("DELETE FROM oauth_pending_states WHERE state = ?").run(state);
}

function dbSetPendingMcpAuth(state: string, auth: PendingMcpAuth): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO oauth_pending_mcp_auth (state, client_id, redirect_uri, state_param, code_challenge, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(state, auth.clientId, auth.redirectUri, auth.state ?? null, auth.codeChallenge, auth.createdAt);
}

function dbGetPendingMcpAuth(state: string): PendingMcpAuth | undefined {
  const db = getDb();
  const row = db.prepare(
    "SELECT client_id, redirect_uri, state_param, code_challenge, created_at_ms FROM oauth_pending_mcp_auth WHERE state = ?"
  ).get(state) as { client_id: string; redirect_uri: string; state_param: string | null; code_challenge: string; created_at_ms: number } | undefined;
  if (!row) return undefined;
  return {
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    state: row.state_param ?? undefined,
    codeChallenge: row.code_challenge,
    createdAt: row.created_at_ms,
  };
}

function dbDeletePendingMcpAuth(state: string): void {
  const db = getDb();
  db.prepare("DELETE FROM oauth_pending_mcp_auth WHERE state = ?").run(state);
}

function cleanupStates(): void {
  const db = getDb();
  const cutoff = Date.now() - STATE_TTL_MS;
  db.prepare("DELETE FROM oauth_pending_states WHERE created_at_ms < ?").run(cutoff);
  db.prepare("DELETE FROM oauth_pending_mcp_auth WHERE created_at_ms < ?").run(cutoff);
}

// --- MCP OAuth: short-lived state in-memory, persistent state in SQLite ---
const authorizationCodes = new Map<string, { clientId: string; codeChallenge: string; redirectUri: string; createdAt: number }>();
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const ACCESS_TOKEN_TTL_S = 3600; // 1 hour
const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600; // 30 days

// --- SQLite-backed MCP token helpers ---

function dbGetClient(clientId: string): OAuthClientInformationFull | undefined {
  const db = getDb();
  const row = db.prepare("SELECT client_info FROM mcp_clients WHERE client_id = ?").get(clientId) as
    | { client_info: string }
    | undefined;
  if (!row) return undefined;
  return JSON.parse(row.client_info) as OAuthClientInformationFull;
}

function dbRegisterClient(clientInfo: OAuthClientInformationFull): void {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO mcp_clients (client_id, client_info) VALUES (?, ?)")
    .run(clientInfo.client_id, JSON.stringify(clientInfo));
}

function dbGetAccessToken(token: string): { clientId: string; expiresAt: number } | undefined {
  const db = getDb();
  const row = db.prepare("SELECT client_id, expires_at FROM mcp_access_tokens WHERE token = ?").get(token) as
    | { client_id: string; expires_at: number }
    | undefined;
  return row ? { clientId: row.client_id, expiresAt: row.expires_at } : undefined;
}

function dbSetAccessToken(token: string, clientId: string, expiresAt: number): void {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO mcp_access_tokens (token, client_id, expires_at) VALUES (?, ?, ?)")
    .run(token, clientId, expiresAt);
}

function dbGetRefreshToken(token: string): { clientId: string; expiresAt: number } | undefined {
  const db = getDb();
  const row = db.prepare("SELECT client_id, expires_at FROM mcp_refresh_tokens WHERE token = ?").get(token) as
    | { client_id: string; expires_at: number }
    | undefined;
  return row ? { clientId: row.client_id, expiresAt: row.expires_at } : undefined;
}

function dbSetRefreshToken(token: string, clientId: string, expiresAt: number): void {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO mcp_refresh_tokens (token, client_id, expires_at) VALUES (?, ?, ?)")
    .run(token, clientId, expiresAt);
}

function dbDeleteRefreshToken(token: string): void {
  const db = getDb();
  db.prepare("DELETE FROM mcp_refresh_tokens WHERE token = ?").run(token);
}

// Cleanup expired tokens every 10 minutes
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();
  db.prepare("DELETE FROM mcp_access_tokens WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM mcp_refresh_tokens WHERE expires_at < ?").run(now);
  const nowMs = Date.now();
  for (const [code, data] of authorizationCodes) {
    if (nowMs - data.createdAt > AUTH_CODE_TTL_MS) authorizationCodes.delete(code);
  }
}, 10 * 60 * 1000);

// --- OAuthRegisteredClientsStore implementation ---
const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId: string) {
    const client = dbGetClient(clientId);
    log.info({ clientId: clientId.slice(0, 8), found: !!client }, "getClient");
    return client;
  },
  registerClient(clientInfo: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) {
    const clientId = randomBytes(16).toString("hex");
    const full: OAuthClientInformationFull = {
      ...clientInfo,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    dbRegisterClient(full);
    log.info({ clientId: clientId.slice(0, 8) }, "registerClient");
    return full;
  },
};

// --- OAuthServerProvider implementation ---
export const oauthProvider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    log.info({ clientId: client.client_id.slice(0, 8), redirectUri: params.redirectUri }, "authorize");
    // If Whoop tokens already exist, auto-approve immediately
    if (getTokens()) {
      const code = randomBytes(32).toString("hex");
      authorizationCodes.set(code, {
        clientId: client.client_id,
        codeChallenge: params.codeChallenge,
        redirectUri: params.redirectUri,
        createdAt: Date.now(),
      });

      const url = new URL(params.redirectUri);
      url.searchParams.set("code", code);
      if (params.state) url.searchParams.set("state", params.state);

      log.info("Whoop tokens exist — auto-approve, redirecting to Claude");
      res.redirect(url.toString());
      return;
    }

    // No Whoop tokens — chain to Whoop OAuth, then complete MCP auth on callback
    log.info("No Whoop tokens — chaining to Whoop OAuth");
    cleanupStates();
    const whoopState = randomBytes(16).toString("hex");
    dbAddPendingState(whoopState);
    dbSetPendingMcpAuth(whoopState, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      createdAt: Date.now(),
    });

    log.info({ state: whoopState.slice(0, 8) }, "pendingMcpAuth stored");
    const whoopUrl = buildAuthUrl(whoopState);
    sendAuthRedirectPage(res, whoopUrl);
  },

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const data = authorizationCodes.get(authorizationCode);
    log.info({ found: !!data, storedCodes: authorizationCodes.size }, "challengeForAuthorizationCode");
    if (!data) throw new Error("Invalid authorization code");
    return data.codeChallenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string
  ): Promise<OAuthTokens> {
    const data = authorizationCodes.get(authorizationCode);
    if (!data || data.clientId !== client.client_id) {
      log.error({ found: !!data }, "exchangeAuthorizationCode FAILED");
      throw new Error("Invalid authorization code");
    }
    log.info("exchangeAuthorizationCode — issuing access + refresh tokens");
    authorizationCodes.delete(authorizationCode);

    const accessToken = randomBytes(32).toString("hex");
    const refreshToken = randomBytes(32).toString("hex");
    const now = Math.floor(Date.now() / 1000);
    dbSetAccessToken(accessToken, client.client_id, now + ACCESS_TOKEN_TTL_S);
    dbSetRefreshToken(refreshToken, client.client_id, now + REFRESH_TOKEN_TTL_S);

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
    };
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string
  ): Promise<OAuthTokens> {
    const data = dbGetRefreshToken(refreshToken);
    if (!data || data.clientId !== client.client_id) {
      log.error({ found: !!data }, "exchangeRefreshToken FAILED");
      throw new Error("Invalid refresh token");
    }
    const now = Math.floor(Date.now() / 1000);
    if (now > data.expiresAt) {
      dbDeleteRefreshToken(refreshToken);
      throw new Error("Refresh token expired");
    }

    // Rotate: delete old, issue new
    dbDeleteRefreshToken(refreshToken);

    const newAccessToken = randomBytes(32).toString("hex");
    const newRefreshToken = randomBytes(32).toString("hex");
    dbSetAccessToken(newAccessToken, client.client_id, now + ACCESS_TOKEN_TTL_S);
    dbSetRefreshToken(newRefreshToken, client.client_id, now + REFRESH_TOKEN_TTL_S);

    return {
      access_token: newAccessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: newRefreshToken,
    };
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Check dynamic tokens from SQLite
    const data = dbGetAccessToken(token);
    if (data && Math.floor(Date.now() / 1000) < data.expiresAt) {
      log.info({ clientId: data.clientId.slice(0, 8) }, "verifyAccessToken — dynamic token valid");
      return {
        token,
        clientId: data.clientId,
        scopes: [],
        expiresAt: data.expiresAt,
      };
    }

    // Check static bearer token
    if (token === config.security.mcpBearerToken) {
      log.info("verifyAccessToken — static bearer token");
      return {
        token,
        clientId: "static",
        scopes: [],
      };
    }

    log.error("verifyAccessToken REJECTED — token not found");
    throw new Error("Invalid or expired token");
  },
};

/**
 * Sends an intermediate HTML page instead of a bare 302 redirect for the
 * Whoop OAuth URL.  Mobile in-app browsers (SFSafariViewController / Chrome
 * Custom Tabs) can close immediately on rapid cross-domain 302 chains before
 * the destination page ever renders.  Serving a real HTML page keeps the
 * browser open; the page auto-redirects after a short delay and provides a
 * manual fallback link so the user always reaches the Whoop login.
 */
function sendAuthRedirectPage(res: Response, whoopUrl: string): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connecting to WHOOP</title>
  <meta http-equiv="refresh" content="2;url=${encodeURI(whoopUrl)}">
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;display:flex;
         align-items:center;justify-content:center;min-height:100vh;
         margin:0;background:#0f0f0f;color:#fff;text-align:center}
    .card{max-width:400px;padding:2rem}
    .spinner{width:40px;height:40px;margin:0 auto 1.5rem;border:3px solid #333;
             border-top-color:#44d62c;border-radius:50%;
             animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    a{color:#44d62c;font-weight:600;text-decoration:none}
    a:hover{text-decoration:underline}
    .hint{color:#999;font-size:.85rem;margin-top:1.5rem}
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h2>Connecting to WHOOP&hellip;</h2>
    <p>You&rsquo;ll be redirected to sign in with your WHOOP account.</p>
    <p style="margin-top:1.5rem"><a id="link" href="${encodeURI(whoopUrl)}">Tap here if you&rsquo;re not redirected</a></p>
    <p class="hint">Keep this browser open until sign-in is complete.</p>
  </div>
  <script>
    // Use location.replace so the back button skips this interstitial
    setTimeout(function(){location.replace(${JSON.stringify(whoopUrl)})},1500);
  </script>
</body>
</html>`);
}

export function createApp(): express.Express {
  const app = express();

  // Trust proxy (Railway runs behind a reverse proxy)
  app.set("trust proxy", 1);

  // CORS
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
  app.use(express.urlencoded({ extended: false }));

  // MCP Auth Router (handles /.well-known/*, /authorize, /token, /register)
  const issuerUrl = new URL(config.server.publicUrl);

  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
  }));

  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // Whoop auth status — requires static bearer token to prevent info leak
  app.get("/auth/status", (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${config.security.mcpBearerToken}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
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

  // Start Whoop OAuth flow
  app.get("/auth/whoop", (_req: Request, res: Response) => {
    cleanupStates();
    const state = randomBytes(16).toString("hex");
    dbAddPendingState(state);
    const whoopUrl = buildAuthUrl(state);
    sendAuthRedirectPage(res, whoopUrl);
  });

  // Whoop OAuth callback
  app.get("/auth/whoop/callback", async (req: Request, res: Response) => {
    log.info({ hasCode: !!req.query.code, state: req.query.state ?? "MISSING" }, "/auth/whoop/callback");
    const { code, state } = req.query;

    if (!state || typeof state !== "string" || !dbHasPendingState(state)) {
      log.error({ state: state ? String(state).slice(0, 8) : "missing" }, "REJECTED — invalid state");
      res.status(400).send("Invalid or expired state parameter");
      return;
    }
    dbDeletePendingState(state);

    if (!code || typeof code !== "string") {
      log.error("REJECTED — missing authorization code");
      res.status(400).send("Missing authorization code");
      return;
    }

    try {
      log.info("Exchanging Whoop auth code for tokens");
      await exchangeCodeForTokens(code);
      log.info("Whoop tokens stored successfully");

      // Check if this was part of a chained MCP auth flow
      const mcpAuth = dbGetPendingMcpAuth(state);
      log.info({ state: state.slice(0, 8), chained: !!mcpAuth }, "pendingMcpAuth lookup");
      if (mcpAuth) {
        dbDeletePendingMcpAuth(state);

        // Complete the MCP authorization by generating a code and redirecting to Claude
        const mcpCode = randomBytes(32).toString("hex");
        authorizationCodes.set(mcpCode, {
          clientId: mcpAuth.clientId,
          codeChallenge: mcpAuth.codeChallenge,
          redirectUri: mcpAuth.redirectUri,
          createdAt: Date.now(),
        });

        const url = new URL(mcpAuth.redirectUri);
        url.searchParams.set("code", mcpCode);
        if (mcpAuth.state) url.searchParams.set("state", mcpAuth.state);

        log.info({ origin: url.origin, path: url.pathname }, "Chained MCP auth complete — redirecting");
        res.redirect(url.toString());
        return;
      }

      // Standalone Whoop auth (not part of MCP flow)
      log.info("Standalone auth complete");
      res.send(`
        <!DOCTYPE html>
        <html><body style="font-family:system-ui;text-align:center;padding:4rem">
          <h1>Connected!</h1>
          <p>Your Whoop account is linked. You can close this tab.</p>
        </body></html>
      `);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error({ err }, "callback ERROR");
      res.status(500).send(`Authorization failed: ${message}`);
    }
  });

  // Global error handler — log unhandled errors
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err }, "Unhandled error");
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error", message: err.message });
    }
  });

  return app;
}

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

// --- Whoop OAuth state store ---
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

// Pending MCP auth params stored while user completes Whoop OAuth
interface PendingMcpAuth {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  createdAt: number;
}
const pendingMcpAuth = new Map<string, PendingMcpAuth>();

function cleanupStates(): void {
  const now = Date.now();
  for (const [state, created] of pendingStates) {
    if (now - created > STATE_TTL_MS) pendingStates.delete(state);
  }
  for (const [state, data] of pendingMcpAuth) {
    if (now - data.createdAt > STATE_TTL_MS) pendingMcpAuth.delete(state);
  }
}

// --- MCP OAuth: in-memory stores ---
const registeredClients = new Map<string, OAuthClientInformationFull>();
const authorizationCodes = new Map<string, { clientId: string; codeChallenge: string; redirectUri: string; createdAt: number }>();
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const accessTokenStore = new Map<string, { clientId: string; expiresAt: number }>();
const refreshTokenStore = new Map<string, { clientId: string; expiresAt: number }>();

const ACCESS_TOKEN_TTL_S = 3600; // 1 hour
const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600; // 30 days

// Cleanup expired tokens every 10 minutes
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [token, data] of accessTokenStore) {
    if (now > data.expiresAt) accessTokenStore.delete(token);
  }
  for (const [token, data] of refreshTokenStore) {
    if (now > data.expiresAt) refreshTokenStore.delete(token);
  }
  const nowMs = Date.now();
  for (const [code, data] of authorizationCodes) {
    if (nowMs - data.createdAt > AUTH_CODE_TTL_MS) authorizationCodes.delete(code);
  }
}, 10 * 60 * 1000);

// --- OAuthRegisteredClientsStore implementation ---
const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId: string) {
    const found = registeredClients.has(clientId);
    console.log(`[auth] getClient ${clientId.slice(0, 8)}… → ${found ? "found" : "NOT FOUND"}`);
    return registeredClients.get(clientId);
  },
  registerClient(clientInfo: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) {
    const clientId = randomBytes(16).toString("hex");
    const full: OAuthClientInformationFull = {
      ...clientInfo,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    registeredClients.set(clientId, full);
    console.log(`[auth] registerClient → ${clientId.slice(0, 8)}… (total: ${registeredClients.size})`);
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
    console.log(`[auth] authorize called for client ${client.client_id.slice(0, 8)}…, redirectUri=${params.redirectUri}`);
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

      console.log(`[auth] Whoop tokens exist → auto-approve, redirecting to Claude`);
      res.redirect(url.toString());
      return;
    }

    // No Whoop tokens — chain to Whoop OAuth, then complete MCP auth on callback
    console.log(`[auth] No Whoop tokens → chaining to Whoop OAuth`);
    cleanupStates();
    const whoopState = randomBytes(16).toString("hex");
    pendingStates.set(whoopState, Date.now());
    pendingMcpAuth.set(whoopState, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      createdAt: Date.now(),
    });

    console.log(`[auth] pendingMcpAuth stored for state ${whoopState.slice(0, 8)}…, pendingStates size=${pendingStates.size}, pendingMcpAuth size=${pendingMcpAuth.size}`);
    const whoopUrl = buildAuthUrl(whoopState);
    sendAuthRedirectPage(res, whoopUrl);
  },

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const data = authorizationCodes.get(authorizationCode);
    console.log(`[auth] challengeForAuthorizationCode → ${data ? "found" : "NOT FOUND"} (stored codes: ${authorizationCodes.size})`);
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
      console.error(`[auth] exchangeAuthorizationCode FAILED — code ${data ? "found but clientId mismatch" : "NOT FOUND"}`);
      throw new Error("Invalid authorization code");
    }
    console.log(`[auth] exchangeAuthorizationCode → success, issuing access + refresh tokens`);
    authorizationCodes.delete(authorizationCode);

    const accessToken = randomBytes(32).toString("hex");
    const refreshToken = randomBytes(32).toString("hex");
    const now = Math.floor(Date.now() / 1000);
    accessTokenStore.set(accessToken, { clientId: client.client_id, expiresAt: now + ACCESS_TOKEN_TTL_S });
    refreshTokenStore.set(refreshToken, { clientId: client.client_id, expiresAt: now + REFRESH_TOKEN_TTL_S });

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
    const data = refreshTokenStore.get(refreshToken);
    if (!data || data.clientId !== client.client_id) {
      console.error(`[auth] exchangeRefreshToken FAILED — token ${data ? "found but clientId mismatch" : "NOT FOUND"} (stored: ${refreshTokenStore.size})`);
      throw new Error("Invalid refresh token");
    }
    const now = Math.floor(Date.now() / 1000);
    if (now > data.expiresAt) {
      refreshTokenStore.delete(refreshToken);
      throw new Error("Refresh token expired");
    }

    // Rotate: delete old, issue new
    refreshTokenStore.delete(refreshToken);

    const newAccessToken = randomBytes(32).toString("hex");
    const newRefreshToken = randomBytes(32).toString("hex");
    accessTokenStore.set(newAccessToken, { clientId: client.client_id, expiresAt: now + ACCESS_TOKEN_TTL_S });
    refreshTokenStore.set(newRefreshToken, { clientId: client.client_id, expiresAt: now + REFRESH_TOKEN_TTL_S });

    return {
      access_token: newAccessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: newRefreshToken,
    };
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Check dynamic tokens
    const data = accessTokenStore.get(token);
    if (data && Math.floor(Date.now() / 1000) < data.expiresAt) {
      console.log(`[auth] verifyAccessToken → dynamic token valid (client ${data.clientId.slice(0, 8)}…)`);
      return {
        token,
        clientId: data.clientId,
        scopes: [],
        expiresAt: data.expiresAt,
      };
    }

    // Check static bearer token
    if (token === config.security.mcpBearerToken) {
      console.log(`[auth] verifyAccessToken → static bearer token`);
      return {
        token,
        clientId: "static",
        scopes: [],
      };
    }

    console.error(`[auth] verifyAccessToken REJECTED — token not in accessTokenStore (${accessTokenStore.size} stored) and not static`);
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

  // Whoop auth status
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

  // Start Whoop OAuth flow
  app.get("/auth/whoop", (_req: Request, res: Response) => {
    cleanupStates();
    const state = randomBytes(16).toString("hex");
    pendingStates.set(state, Date.now());
    const whoopUrl = buildAuthUrl(state);
    sendAuthRedirectPage(res, whoopUrl);
  });

  // Whoop OAuth callback
  app.get("/auth/whoop/callback", async (req: Request, res: Response) => {
    console.log(`[callback] /auth/whoop/callback hit — query: code=${req.query.code ? "present" : "MISSING"}, state=${req.query.state ?? "MISSING"}`);
    const { code, state } = req.query;

    if (!state || typeof state !== "string" || !pendingStates.has(state)) {
      console.error(`[callback] REJECTED — state ${state ? `"${String(state).slice(0, 8)}…" not in pendingStates` : "missing"} (pendingStates size=${pendingStates.size})`);
      res.status(400).send("Invalid or expired state parameter");
      return;
    }
    pendingStates.delete(state);

    if (!code || typeof code !== "string") {
      console.error(`[callback] REJECTED — missing authorization code`);
      res.status(400).send("Missing authorization code");
      return;
    }

    try {
      console.log(`[callback] Exchanging Whoop auth code for tokens…`);
      await exchangeCodeForTokens(code);
      console.log(`[callback] Whoop tokens stored successfully`);

      // Check if this was part of a chained MCP auth flow
      const mcpAuth = pendingMcpAuth.get(state);
      console.log(`[callback] pendingMcpAuth for state ${state.slice(0, 8)}… → ${mcpAuth ? "FOUND (chained flow)" : "NOT FOUND (standalone)"}`);
      if (mcpAuth) {
        pendingMcpAuth.delete(state);

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

        console.log(`[callback] Chained MCP auth complete → redirecting to ${url.origin}${url.pathname}`);
        res.redirect(url.toString());
        return;
      }

      // Standalone Whoop auth (not part of MCP flow)
      console.log(`[callback] Standalone auth complete → showing success page`);
      res.send(`
        <!DOCTYPE html>
        <html><body style="font-family:system-ui;text-align:center;padding:4rem">
          <h1>Connected!</h1>
          <p>Your Whoop account is linked. You can close this tab.</p>
        </body></html>
      `);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[callback] ERROR:`, err);
      res.status(500).send(`Authorization failed: ${message}`);
    }
  });

  // Global error handler — log unhandled errors
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error", message: err.message });
    }
  });

  return app;
}

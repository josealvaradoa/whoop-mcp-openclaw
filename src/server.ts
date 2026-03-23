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

function cleanupStates(): void {
  const now = Date.now();
  for (const [state, created] of pendingStates) {
    if (now - created > STATE_TTL_MS) pendingStates.delete(state);
  }
}

// --- MCP OAuth: in-memory stores ---
const registeredClients = new Map<string, OAuthClientInformationFull>();
const authorizationCodes = new Map<string, { clientId: string; codeChallenge: string; redirectUri: string }>();
const accessTokenStore = new Map<string, { clientId: string; expiresAt: number }>();

const ACCESS_TOKEN_TTL_S = 3600; // 1 hour

// Cleanup expired tokens every 10 minutes
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [token, data] of accessTokenStore) {
    if (now > data.expiresAt) accessTokenStore.delete(token);
  }
}, 10 * 60 * 1000);

// --- OAuthRegisteredClientsStore implementation ---
const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId: string) {
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
    // Single-user server: auto-approve authorization
    const code = randomBytes(32).toString("hex");
    authorizationCodes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
    });

    const url = new URL(params.redirectUri);
    url.searchParams.set("code", code);
    if (params.state) url.searchParams.set("state", params.state);

    res.redirect(url.toString());
  },

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const data = authorizationCodes.get(authorizationCode);
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
      throw new Error("Invalid authorization code");
    }
    authorizationCodes.delete(authorizationCode);

    const accessToken = randomBytes(32).toString("hex");
    const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_S;
    accessTokenStore.set(accessToken, { clientId: client.client_id, expiresAt });

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
    };
  },

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new Error("Refresh tokens not supported");
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Check dynamic tokens
    const data = accessTokenStore.get(token);
    if (data && Math.floor(Date.now() / 1000) < data.expiresAt) {
      return {
        token,
        clientId: data.clientId,
        scopes: [],
        expiresAt: data.expiresAt,
      };
    }

    // Check static bearer token
    if (token === config.security.mcpBearerToken) {
      return {
        token,
        clientId: "static",
        scopes: [],
      };
    }

    throw new Error("Invalid or expired token");
  },
};

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
    res.redirect(buildAuthUrl(state));
  });

  // Whoop OAuth callback
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

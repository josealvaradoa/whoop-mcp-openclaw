import express from "express";
import type { Request, Response, NextFunction } from "express";
import { randomBytes, createHash } from "node:crypto";
import { config } from "./config.js";
import { buildAuthUrl, exchangeCodeForTokens, getTokens } from "./whoop/auth.js";

// OAuth state store for Whoop: state -> creation timestamp
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

// MCP OAuth: authorization codes -> { clientId, redirectUri, codeChallenge, expiry }
interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiry: number;
}
const authCodes = new Map<string, AuthCode>();
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// MCP OAuth: access tokens -> expiry timestamp
const accessTokens = new Map<string, number>();
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Dynamic client registration store
const registeredClients = new Map<string, { clientId: string; clientSecret: string }>();

function cleanupStates(): void {
  const now = Date.now();
  for (const [state, created] of pendingStates) {
    if (now - created > STATE_TTL_MS) pendingStates.delete(state);
  }
}

// Cleanup expired tokens and codes every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of accessTokens) {
    if (now > expiry) accessTokens.delete(token);
  }
  for (const [code, data] of authCodes) {
    if (now > data.expiry) authCodes.delete(code);
  }
}, 10 * 60 * 1000);

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = authHeader.slice(7);

  // Accept static bearer token (curl/direct)
  if (token === config.security.mcpBearerToken) {
    next();
    return;
  }

  // Accept dynamically-issued OAuth access tokens (Claude Custom Connectors)
  const expiry = accessTokens.get(token);
  if (expiry && Date.now() < expiry) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

function isValidClient(clientId: string, clientSecret: string): boolean {
  // Check static config
  if (
    clientId === config.security.mcpOAuthClientId &&
    clientSecret === config.security.mcpOAuthClientSecret
  ) {
    return true;
  }
  // Check dynamically registered clients
  const registered = registeredClients.get(clientId);
  return registered?.clientSecret === clientSecret;
}

export function createApp(): express.Express {
  const app = express();

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

  // OAuth 2.0 Authorization Server Metadata (RFC 8414)
  app.get("/.well-known/oauth-authorization-server", (req: Request, res: Response) => {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      grant_types_supported: ["authorization_code"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  // Dynamic Client Registration (RFC 7591)
  app.post("/oauth/register", (_req: Request, res: Response) => {
    const clientId = randomBytes(16).toString("hex");
    const clientSecret = randomBytes(32).toString("hex");
    registeredClients.set(clientId, { clientId, clientSecret });

    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    });
  });

  // OAuth 2.0 Authorization Endpoint
  // Single-user server: auto-approve and redirect back with code
  app.get("/authorize", (req: Request, res: Response) => {
    const clientId = req.query.client_id as string;
    const redirectUri = req.query.redirect_uri as string;
    const state = req.query.state as string | undefined;
    const codeChallenge = req.query.code_challenge as string | undefined;
    const codeChallengeMethod = req.query.code_challenge_method as string | undefined;

    if (!clientId || !redirectUri) {
      res.status(400).send("Missing client_id or redirect_uri");
      return;
    }

    // Generate authorization code
    const code = randomBytes(32).toString("hex");
    authCodes.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      expiry: Date.now() + AUTH_CODE_TTL_MS,
    });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);

    res.redirect(url.toString());
  });

  // OAuth 2.0 Token Endpoint
  app.post("/oauth/token", (req: Request, res: Response) => {
    const grantType = req.body.grant_type;

    if (grantType === "authorization_code") {
      const code = req.body.code as string;
      const clientId = req.body.client_id as string;
      const clientSecret = req.body.client_secret as string | undefined;
      const codeVerifier = req.body.code_verifier as string | undefined;

      const authCode = authCodes.get(code);
      if (!authCode || Date.now() > authCode.expiry) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }

      // Verify client
      if (authCode.clientId !== clientId) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }

      // Verify PKCE if code_challenge was provided
      if (authCode.codeChallenge && codeVerifier) {
        const expected = createHash("sha256")
          .update(codeVerifier)
          .digest("base64url");
        if (expected !== authCode.codeChallenge) {
          res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
      }

      // Verify client secret if provided (non-PKCE flow)
      if (clientSecret && !isValidClient(clientId, clientSecret)) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }

      authCodes.delete(code);

      const token = randomBytes(32).toString("hex");
      const expiresIn = Math.floor(ACCESS_TOKEN_TTL_MS / 1000);
      accessTokens.set(token, Date.now() + ACCESS_TOKEN_TTL_MS);

      res.json({
        access_token: token,
        token_type: "Bearer",
        expires_in: expiresIn,
      });
      return;
    }

    if (grantType === "client_credentials") {
      const clientId = req.body.client_id as string;
      const clientSecret = req.body.client_secret as string;

      if (!isValidClient(clientId, clientSecret)) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }

      const token = randomBytes(32).toString("hex");
      const expiresIn = Math.floor(ACCESS_TOKEN_TTL_MS / 1000);
      accessTokens.set(token, Date.now() + ACCESS_TOKEN_TTL_MS);

      res.json({
        access_token: token,
        token_type: "Bearer",
        expires_in: expiresIn,
      });
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

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

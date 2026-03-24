import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from "node:crypto";
import { getDb } from "../db/connection.js";
import { config } from "../config.js";
import type { OAuthTokenResponse } from "./types.js";

const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const SCOPES = "read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement";

// In-memory token cache to avoid PBKDF2 on every call
let cachedAccessToken: string | null = null;
let cachedExpiresAt: number | null = null;

// --- Encryption ---

function deriveKey(secret: string, salt: Buffer): Buffer {
  return pbkdf2Sync(secret, salt, 100_000, 32, "sha256");
}

export function encrypt(plaintext: string, secret: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(secret, salt);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    salt.toString("base64"),
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function decrypt(encrypted: string, secret: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 4) {
    throw new Error("Malformed encrypted token: expected 4 colon-separated segments");
  }
  const [saltB64, ivB64, authTagB64, ciphertextB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  const key = deriveKey(secret, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// --- Token Storage ---

export function storeTokens(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  scope: string
): void {
  const secret = config.security.encryptionSecret;
  const accessEncrypted = encrypt(accessToken, secret);
  const refreshEncrypted = encrypt(refreshToken, secret);
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  const db = getDb();
  db.prepare(`
    INSERT INTO tokens (id, access_token_encrypted, refresh_token_encrypted, expires_at, scope)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token_encrypted = excluded.access_token_encrypted,
      refresh_token_encrypted = excluded.refresh_token_encrypted,
      expires_at = excluded.expires_at,
      scope = excluded.scope,
      updated_at = unixepoch()
  `).run(accessEncrypted, refreshEncrypted, expiresAt, scope);

  // Update in-memory cache
  cachedAccessToken = accessToken;
  cachedExpiresAt = expiresAt;
}

export function getTokens(): {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
} | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM tokens WHERE id = 1").get() as
    | {
        access_token_encrypted: string;
        refresh_token_encrypted: string;
        expires_at: number;
        scope: string;
      }
    | undefined;

  if (!row) return null;

  try {
    const secret = config.security.encryptionSecret;
    return {
      accessToken: decrypt(row.access_token_encrypted, secret),
      refreshToken: decrypt(row.refresh_token_encrypted, secret),
      expiresAt: row.expires_at,
      scope: row.scope,
    };
  } catch (err) {
    console.error("Failed to decrypt stored tokens, treating as missing:", err);
    return null;
  }
}

// --- Token Refresh ---

let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  // Prevent concurrent refreshes — Whoop refresh tokens are single-use
  if (refreshPromise) return refreshPromise;

  refreshPromise = doRefreshAccessToken();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function doRefreshAccessToken(): Promise<string> {
  console.log(`[whoop-auth] Attempting token refresh…`);
  const tokens = getTokens();
  if (!tokens) {
    throw new Error("No tokens stored. Please authorize at /auth/whoop");
  }

  if (!tokens.refreshToken) {
    throw new Error("No refresh token available. Please re-authorize at /auth/whoop");
  }

  const response = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: config.whoop.clientId,
      client_secret: config.whoop.clientSecret,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`[whoop-auth] Token refresh FAILED (${response.status}): ${body}`);
    cachedAccessToken = null;
    cachedExpiresAt = null;
    // Clear stale tokens from DB so the next check gives a clean "no tokens" state
    const db = getDb();
    db.prepare("DELETE FROM tokens WHERE id = 1").run();
    throw new Error(
      `Token refresh failed (${response.status}). Please re-authorize at /auth/whoop`
    );
  }

  const data = (await response.json()) as OAuthTokenResponse;
  console.log(`[whoop-auth] Token refresh succeeded — expires_in=${data.expires_in}s`);
  storeTokens(data.access_token, data.refresh_token, data.expires_in, data.scope);
  return data.access_token;
}

export async function getValidAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // Use in-memory cache if token is still valid (with 5-min buffer)
  if (cachedAccessToken && cachedExpiresAt && cachedExpiresAt - now > 300) {
    return cachedAccessToken;
  }

  // Try to load from DB
  const tokens = getTokens();
  if (!tokens) {
    console.error(`[whoop-auth] getValidAccessToken — no tokens in DB`);
    throw new Error("No tokens stored. Please authorize at /auth/whoop");
  }

  // If token is still valid, cache and return
  if (tokens.expiresAt - now > 300) {
    console.log(`[whoop-auth] getValidAccessToken — loaded from DB, expires in ${tokens.expiresAt - now}s`);
    cachedAccessToken = tokens.accessToken;
    cachedExpiresAt = tokens.expiresAt;
    return tokens.accessToken;
  }

  // Token expiring soon — refresh
  console.log(`[whoop-auth] getValidAccessToken — token expires in ${tokens.expiresAt - now}s, refreshing`);
  return refreshAccessToken();
}

// --- OAuth Flow ---

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.whoop.clientId,
    redirect_uri: config.whoop.redirectUri,
    response_type: "code",
    scope: SCOPES,
    state,
  });
  return `${WHOOP_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<void> {
  console.log(`[whoop-auth] Exchanging authorization code for tokens (redirect_uri=${config.whoop.redirectUri})`);
  const response = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: config.whoop.clientId,
      client_secret: config.whoop.clientSecret,
      redirect_uri: config.whoop.redirectUri,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`[whoop-auth] Token exchange FAILED (${response.status}): ${body}`);
    throw new Error(`Token exchange failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  console.log(`[whoop-auth] Token exchange response keys: ${JSON.stringify(Object.keys(data))}`);

  const accessToken = data.access_token as string | undefined;
  const refreshToken = data.refresh_token as string | undefined;
  const expiresIn = data.expires_in as number | undefined;
  const scope = data.scope as string | undefined;

  if (!accessToken || !expiresIn) {
    throw new Error(`Unexpected token response shape: ${JSON.stringify(Object.keys(data))}`);
  }

  storeTokens(accessToken, refreshToken ?? "", expiresIn, scope ?? "");
  console.log(`[whoop-auth] Tokens stored — expires_in=${expiresIn}s, scope=${scope ?? "none"}`);
}

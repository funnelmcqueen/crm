// The OAuth 2.0 + PKCE round trip that connects a Google account (docs/DEVIATIONS.md D47). Like
// src/server/google/api.ts, this only ever takes credentials as arguments or reads them from the server
// environment: nothing here reads the database or the request context. Errors never carry the code, a
// token or the client secret — only a generic message safe to log a reason for.
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getServerEnv } from "@/server/env";

/** Least privilege (design §3): free/busy on the primary calendar, writes only on a calendar the app itself created. */
export const GOOGLE_SCOPES: readonly string[] = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.app.created",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const OAUTH_TIMEOUT_MS = 8000;

/** RFC 7636 PKCE pair: a random verifier and its S256 challenge. Both are URL-safe, unpadded base64. */
export function newPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Google's consent screen URL: offline access, forced consent (so a refresh token always comes back), PKCE. */
export function consentUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge_method: "S256",
    code_challenge: input.codeChallenge,
    state: input.state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Marks a rejection from the timeout race, mirroring src/server/google/api.ts's requestOnce. */
class TimeoutSignal extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutSignal("Google OAuth request timed out"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

class ConnectionError extends Error {}

/** One attempt with an 8s timeout; a timeout or connection failure becomes a ConnectionError (retryable). */
async function requestOnce(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  try {
    return await withTimeout(fetch(url, { ...init, signal: controller.signal }), OAUTH_TIMEOUT_MS, controller);
  } catch (err) {
    if (err instanceof TimeoutSignal) throw new ConnectionError("timeout");
    if (err instanceof TypeError) throw new ConnectionError("connection_error");
    throw err;
  }
}

/** Retries once, only for a connection error or timeout — never for an HTTP status Google returned. */
async function requestWithRetry(url: string, init: RequestInit): Promise<Response> {
  try {
    return await requestOnce(url, init);
  } catch (err) {
    if (err instanceof ConnectionError) return await requestOnce(url, init);
    throw err;
  }
}

interface TokenExchangeBody {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

/** Exchanges the authorization code (with its PKCE verifier) for tokens. Throws if no refresh token comes back. */
export async function exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<{
  refreshToken: string;
  accessToken: string;
}> {
  const env = getServerEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google Calendar is not configured");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    code_verifier: input.codeVerifier,
  });

  const res = await requestWithRetry(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Google token exchange failed (HTTP ${res.status})`);
  }
  const data = (await res.json()) as TokenExchangeBody;
  if (!data.refresh_token) {
    throw new Error("Google did not return a refresh token");
  }
  return { refreshToken: data.refresh_token, accessToken: data.access_token };
}

/** Best effort, per design §5: a failure here must never block disconnecting, so it is swallowed. */
export async function revokeToken(refreshToken: string): Promise<void> {
  try {
    const body = new URLSearchParams({ token: refreshToken });
    const res = await requestWithRetry(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    await res.body?.cancel().catch(() => undefined);
  } catch {
    // Best effort: never throws.
  }
}

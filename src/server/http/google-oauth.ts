// GET /api/google/start and GET /api/google/callback: the admin-only OAuth + PKCE round trip that
// connects the Google account (design §5, docs/DEVIATIONS.md D47). The state and PKCE verifier travel in
// one short-lived, httpOnly cookie scoped to /api/google; the callback never writes anything until it has
// re-checked the caller is still an admin and the state matches the cookie in constant time. Never logs a
// code, a token or the client secret — an unexpected failure logs only { step, status, reason }.
import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { getRouteAuth, requireAdmin, type RequestContext } from "@/server/context";
import { getServerEnv, type ServerEnv } from "@/server/env";
import { AppError, isNextControlFlowError, mapPostgrestError, toHttpResponse } from "@/server/errors";
import { accountEmail, createAppCalendar, GoogleApiError } from "@/server/google/api";
import { encryptRefreshToken } from "@/server/google/crypto";
import { consentUrl, exchangeCode, newPkcePair } from "@/server/google/oauth";
import { NO_STORE } from "@/server/http/browser";

export interface GoogleOAuthDeps {
  env: ServerEnv;
}

type CalendarStatus = "connected" | "denied" | "error";

const COOKIE_NAME = "gcal_oauth";
const COOKIE_PATH = "/api/google";
const COOKIE_MAX_AGE_SECONDS = 600;
const APP_CALENDAR_TITLE = "Funnel McQueen meetings";

function resolveEnv(deps: Partial<GoogleOAuthDeps>): { env: ServerEnv } | { response: Response } {
  if (deps.env) return { env: deps.env };
  try {
    return { env: getServerEnv() };
  } catch (error) {
    logGoogleOAuthError("env", error);
    return { response: toHttpResponse(new AppError("unavailable")) };
  }
}

function googleConfigured(env: ServerEnv): env is ServerEnv & { GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string; APP_BASE_URL: string } {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.APP_BASE_URL);
}

function cookieAttributes(env: ServerEnv): string[] {
  const attrs = [`Path=${COOKIE_PATH}`, "HttpOnly", "SameSite=Lax"];
  if (env.NODE_ENV !== "development") attrs.push("Secure");
  return attrs;
}

/** name=base64url(JSON({state, verifier})): both values travel in one cookie, per design §5. */
function encodeStateCookie(state: string, verifier: string): string {
  return Buffer.from(JSON.stringify({ state, verifier }), "utf8").toString("base64url");
}

function setStateCookie(env: ServerEnv, state: string, verifier: string): string {
  return [`${COOKIE_NAME}=${encodeStateCookie(state, verifier)}`, `Max-Age=${COOKIE_MAX_AGE_SECONDS}`, ...cookieAttributes(env)].join("; ");
}

/** Cleared the same way on every branch of the callback (start's cookie, denial, error or success). */
function clearStateCookie(env: ServerEnv): string {
  return [`${COOKIE_NAME}=`, "Max-Age=0", ...cookieAttributes(env)].join("; ");
}

function readStateCookie(req: Request): { state: string; verifier: string } | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const raw = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw.slice(COOKIE_NAME.length + 1), "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { state, verifier } = parsed as { state?: unknown; verifier?: unknown };
    if (typeof state !== "string" || typeof verifier !== "string" || state === "" || verifier === "") return null;
    return { state, verifier };
  } catch {
    return null;
  }
}

/** node:crypto's timingSafeEqual requires equal-length buffers, so an unequal length is a plain mismatch. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Never a code, token or secret — just enough to see where a connection attempt broke. */
function logGoogleOAuthError(step: string, error: unknown): void {
  if (error instanceof GoogleApiError) {
    console.error("[google-oauth]", { step, status: error.status, reason: error.reason });
    return;
  }
  if (error instanceof AppError) {
    console.error("[google-oauth]", { step, status: error.status, reason: error.code });
    return;
  }
  console.error("[google-oauth]", { step, status: 0, reason: error instanceof Error ? error.name : "unknown" });
}

/** GET /api/google/start: admin session required. Redirects to Google's consent screen. */
export async function handleGoogleStart(req: Request, deps: Partial<GoogleOAuthDeps> = {}): Promise<Response> {
  const resolved = resolveEnv(deps);
  if ("response" in resolved) return resolved.response;
  const { env } = resolved;

  let auth: Awaited<ReturnType<typeof getRouteAuth>>;
  try {
    auth = await getRouteAuth(req);
  } catch (error) {
    return toHttpResponse(error);
  }
  const { ctx, applyCookies } = auth;

  try {
    requireAdmin(ctx);
    if (!googleConfigured(env)) throw new AppError("unavailable");

    const { verifier, challenge } = newPkcePair();
    const state = randomBytes(24).toString("base64url");
    const redirectUri = `${env.APP_BASE_URL}/api/google/callback`;
    const location = consentUrl({ clientId: env.GOOGLE_CLIENT_ID, redirectUri, state, codeChallenge: challenge });

    const res = new Response(null, { status: 302, headers: { Location: location, ...NO_STORE } });
    res.headers.append("Set-Cookie", setStateCookie(env, state, verifier));
    return applyCookies(res);
  } catch (error) {
    return applyCookies(toHttpResponse(error));
  }
}

/** GET /api/google/callback: re-checks the admin session, verifies state, exchanges the code, and connects. */
export async function handleGoogleCallback(req: Request, deps: Partial<GoogleOAuthDeps> = {}): Promise<Response> {
  const resolved = resolveEnv(deps);
  if ("response" in resolved) return resolved.response;
  const { env } = resolved;

  let auth: Awaited<ReturnType<typeof getRouteAuth>>;
  try {
    auth = await getRouteAuth(req);
  } catch (error) {
    return toHttpResponse(error);
  }
  const { ctx, applyCookies } = auth;

  const withClearedCookie = (res: Response): Response => {
    res.headers.append("Set-Cookie", clearStateCookie(env));
    return applyCookies(res);
  };

  const toSettings = (status: CalendarStatus): Response => {
    const base = env.APP_BASE_URL ?? "";
    return withClearedCookie(new Response(null, { status: 302, headers: { Location: `${base}/settings?calendar=${status}`, ...NO_STORE } }));
  };

  let active: RequestContext;
  try {
    active = requireAdmin(ctx);
  } catch (error) {
    return withClearedCookie(toHttpResponse(error));
  }

  if (!googleConfigured(env)) return toSettings("error");

  const url = new URL(req.url);
  if (url.searchParams.get("error")) return toSettings("denied");

  const cookie = readStateCookie(req);
  const stateParam = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!cookie || !stateParam || !code || !constantTimeEqual(stateParam, cookie.state)) return toSettings("error");

  const redirectUri = `${env.APP_BASE_URL}/api/google/callback`;

  let refreshToken: string;
  let accessToken: string;
  try {
    ({ refreshToken, accessToken } = await exchangeCode({ code, codeVerifier: cookie.verifier, redirectUri }));
  } catch (error) {
    if (isNextControlFlowError(error)) throw error;
    logGoogleOAuthError("exchange_code", error);
    return toSettings("error");
  }

  let email: string;
  try {
    email = await accountEmail(accessToken);
  } catch (error) {
    if (isNextControlFlowError(error)) throw error;
    logGoogleOAuthError("account_email", error);
    return toSettings("error");
  }

  const { data: settingsRow } = await active.supabase.from("settings").select("default_timezone").limit(1).maybeSingle();
  const timeZone = settingsRow?.default_timezone ?? "America/New_York";

  let appCalendarId: string;
  try {
    appCalendarId = (await createAppCalendar(accessToken, APP_CALENDAR_TITLE, timeZone)).id;
  } catch (error) {
    if (isNextControlFlowError(error)) throw error;
    logGoogleOAuthError("create_app_calendar", error);
    return toSettings("error");
  }

  try {
    const ciphertext = encryptRefreshToken(refreshToken);
    const { error: rpcError } = await active.supabase.rpc("connect_calendar", {
      p_email: email,
      p_ciphertext: ciphertext,
      p_app_calendar_id: appCalendarId,
    });
    if (rpcError) throw mapPostgrestError(rpcError);
  } catch (error) {
    if (isNextControlFlowError(error)) throw error;
    logGoogleOAuthError("connect_calendar", error);
    return toSettings("error");
  }

  return toSettings("connected");
}

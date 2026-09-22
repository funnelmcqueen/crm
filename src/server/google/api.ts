// The Calendar/OAuth2 REST calls (docs/DEVIATIONS.md D47) — the other Google HTTP caller is
// src/server/google/oauth.ts (the authorization-code exchange and token revocation), and both share their
// timeout+retry plumbing through src/server/google/http.ts. Every function here takes an access token as
// an argument; nothing here reads the database, the request context, or the environment beyond
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET for the token refresh. Errors carry a status and a short reason
// code only — never a token, a secret, or a request/response body.
import "server-only";
import { getServerEnv } from "@/server/env";
import { GOOGLE_HTTP_TIMEOUT_MS, GoogleConnectionFailure, requestWithRetry as googleRequestWithRetry } from "@/server/google/http";

/** Kept under its historical name: tests/unit/google/api.test.ts imports it to drive fake timers. */
export const GOOGLE_TIMEOUT_MS = GOOGLE_HTTP_TIMEOUT_MS;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/** Cached per refresh token until 60 seconds before its expiry (accessTokenFor). */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

export interface GoogleTokens {
  accessToken: string;
  expiresAt: number;
}

export interface GoogleEventInput {
  summary: string;
  description: string;
  start: Date;
  end: Date;
  timeZone: string;
  attendeeEmail: string | null;
  conferenceRequestId: string;
}

export class GoogleApiError extends Error {
  readonly kind: "invalid_grant" | "transient" | "permanent";
  readonly status: number;
  readonly reason: string;

  constructor(kind: GoogleApiError["kind"], status: number, reason: string) {
    super(`Google API error: ${kind} (HTTP ${status}, ${reason})`);
    this.name = "GoogleApiError";
    this.kind = kind;
    this.status = status;
    this.reason = reason;
  }
}

/** Module-level access-token cache, keyed by refresh token. Access tokens never touch the database. */
const tokenCache = new Map<string, GoogleTokens>();

interface GoogleErrorDetail {
  reason?: string;
}

interface GoogleErrorBody {
  error?: string | { errors?: GoogleErrorDetail[]; status?: string; message?: string };
}

/** Pulls a short machine-readable reason out of either OAuth2's flat error or the Calendar API's nested one. */
function extractReason(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const error = (body as GoogleErrorBody).error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    return error.errors?.[0]?.reason ?? error.status ?? undefined;
  }
  return undefined;
}

function classify(status: number, body: unknown): { kind: GoogleApiError["kind"]; reason: string } {
  const reason = extractReason(body) ?? `http_${status}`;
  if (reason === "invalid_grant" || reason === "unauthorized_client") {
    return { kind: "invalid_grant", reason };
  }
  if (status === 429 || (status >= 500 && status < 600) || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
    return { kind: "transient", reason };
  }
  return { kind: "permanent", reason };
}

/** The shared timeout+retry primitive (src/server/google/http.ts), mapped to this module's own error type. */
async function requestWithRetry(url: string, init: RequestInit): Promise<Response> {
  try {
    return await googleRequestWithRetry(url, init);
  } catch (err) {
    if (err instanceof GoogleConnectionFailure) throw new GoogleApiError("transient", 0, err.reason);
    throw err;
  }
}

/** Fetches, parses JSON, and throws a classified GoogleApiError for a non-2xx response. */
async function request<T>(url: string, init: RequestInit): Promise<T> {
  const res = await requestWithRetry(url, init);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const { kind, reason } = classify(res.status, body);
    throw new GoogleApiError(kind, res.status, reason);
  }
  return body as T;
}

interface TokenResponseBody {
  access_token: string;
  expires_in: number;
}

/** Refreshes an access token, caching it per refresh token until 60 seconds before it expires. */
export async function accessTokenFor(refreshToken: string, now: () => number = Date.now): Promise<string> {
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt - TOKEN_EXPIRY_SKEW_MS > now()) {
    return cached.accessToken;
  }

  const env = getServerEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google Calendar is not configured");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });

  try {
    const data = await request<TokenResponseBody>(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const tokens: GoogleTokens = { accessToken: data.access_token, expiresAt: now() + data.expires_in * 1000 };
    tokenCache.set(refreshToken, tokens);
    return tokens.accessToken;
  } catch (err) {
    if (err instanceof GoogleApiError && err.kind === "invalid_grant") {
      tokenCache.delete(refreshToken);
    }
    throw err;
  }
}

interface FreeBusyCalendarEntry {
  busy?: Array<{ start: string; end: string }>;
  errors?: GoogleErrorDetail[];
}

interface FreeBusyResponseBody {
  calendars?: Record<string, FreeBusyCalendarEntry>;
}

/** Reads busy time only — never a title, description or attendee (design §3). */
export async function freeBusy(
  accessToken: string,
  calendarIds: readonly string[],
  from: Date,
  to: Date,
): Promise<Array<{ start: Date; end: Date }>> {
  const data = await request<FreeBusyResponseBody>(FREEBUSY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      items: calendarIds.map((id) => ({ id })),
    }),
  });

  const intervals: Array<{ start: Date; end: Date }> = [];
  for (const calendarId of calendarIds) {
    const entry = data.calendars?.[calendarId];
    if (!entry) continue;
    if (entry.errors && entry.errors.length > 0) {
      const reason = entry.errors[0]?.reason ?? "unknown";
      throw new GoogleApiError("permanent", 200, reason);
    }
    for (const busy of entry.busy ?? []) {
      intervals.push({ start: new Date(busy.start), end: new Date(busy.end) });
    }
  }
  intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
  return intervals;
}

/** Inserts a Meet-conferenced event, optionally inviting the lead. Never reads an event back. */
export async function insertEvent(accessToken: string, calendarId: string, event: GoogleEventInput): Promise<{ id: string }> {
  const query = new URLSearchParams({ conferenceDataVersion: "1", sendUpdates: "all" });
  const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${query.toString()}`;

  const body: Record<string, unknown> = {
    summary: event.summary,
    description: event.description,
    start: { dateTime: event.start.toISOString(), timeZone: event.timeZone },
    end: { dateTime: event.end.toISOString(), timeZone: event.timeZone },
    conferenceData: {
      createRequest: {
        requestId: event.conferenceRequestId,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };
  if (event.attendeeEmail) {
    body.attendees = [{ email: event.attendeeEmail }];
  }

  const data = await request<{ id: string }>(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { id: data.id };
}

/** Deletes the event. 404/410 (already gone) count as success, matching design §7. */
export async function deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const res = await requestWithRetry(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 204 || res.status === 404 || res.status === 410) {
    await res.body?.cancel().catch(() => undefined);
    return;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const { kind, reason } = classify(res.status, body);
    throw new GoogleApiError(kind, res.status, reason);
  }
}

/** Creates the secondary calendar the app writes meetings to (design §3), on first connect. */
export async function createAppCalendar(accessToken: string, summary: string, timeZone: string): Promise<{ id: string }> {
  const data = await request<{ id: string }>(`${CALENDAR_API_BASE}/calendars`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ summary, timeZone }),
  });
  return { id: data.id };
}

/** The connected account's email — shown in Settings and used as the primary calendar's id. */
export async function accountEmail(accessToken: string): Promise<string> {
  const data = await request<{ email: string }>(USERINFO_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data.email;
}

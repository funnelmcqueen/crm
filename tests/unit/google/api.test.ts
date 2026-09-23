// The Google HTTP layer (docs/DEVIATIONS.md D47): accessTokenFor, freeBusy, insertEvent, deleteEvent,
// createAppCalendar, accountEmail. Every test stubs globalThis.fetch — no test may reach the network.
// Tokens/secrets below are obvious fakes ("test-..."), never a real value.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/server/env";
import {
  GOOGLE_TIMEOUT_MS,
  GoogleApiError,
  accessTokenFor,
  accountEmail,
  createAppCalendar,
  deleteEvent,
  freeBusy,
  insertEvent,
} from "@/server/google/api";

const BASE_ENV = {
  NODE_ENV: "test",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321/",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
};

const ACCESS_TOKEN = "test-access-token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function tokenResponse(accessToken: string, expiresIn = 3600): Response {
  return jsonResponse({ access_token: accessToken, expires_in: expiresIn, token_type: "Bearer" });
}

describe("src/server/google/api", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
    resetEnvCacheForTests();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    resetEnvCacheForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("accessTokenFor", () => {
    it("posts form-encoded grant_type=refresh_token with the client id and secret, and returns the access token", async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse("access-token-1"));

      const token = await accessTokenFor("refresh-token-basic", () => 1_000_000);

      expect(token).toBe("access-token-1");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://oauth2.googleapis.com/token");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
      const params = new URLSearchParams(init.body as string);
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("refresh-token-basic");
      expect(params.get("client_id")).toBe("test-client-id");
      expect(params.get("client_secret")).toBe("test-client-secret");
    });

    it("caches within the expiry window and refreshes again once the cache is stale", async () => {
      let now = 1_000_000;
      const nowFn = () => now;
      fetchMock.mockResolvedValueOnce(tokenResponse("access-token-a", 3600));

      const first = await accessTokenFor("refresh-token-cache", nowFn);
      expect(first).toBe("access-token-a");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Still well inside the 3600s expiry (minus the 60s skew).
      now += 1_000;
      const second = await accessTokenFor("refresh-token-cache", nowFn);
      expect(second).toBe("access-token-a");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Past expiresAt - 60s: must refresh again.
      now += 3600 * 1000;
      fetchMock.mockResolvedValueOnce(tokenResponse("access-token-b", 3600));
      const third = await accessTokenFor("refresh-token-cache", nowFn);
      expect(third).toBe("access-token-b");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("throws GoogleApiError with kind invalid_grant for a token error body", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400));

      const err = await accessTokenFor("refresh-token-invalid", () => 2_000_000).catch((e) => e);

      expect(err).toBeInstanceOf(GoogleApiError);
      expect((err as GoogleApiError).kind).toBe("invalid_grant");
      expect((err as GoogleApiError).status).toBe(400);
    });
  });

  describe("error classification", () => {
    it("a 503 is transient", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: { code: 503, message: "Backend Error", errors: [{ domain: "global", reason: "backendError" }] } }, 503),
      );
      const err = await accessTokenFor("refresh-token-503", () => 3_000_000).catch((e) => e);
      expect(err).toBeInstanceOf(GoogleApiError);
      expect((err as GoogleApiError).kind).toBe("transient");
    });

    it("a 403 with reason rateLimitExceeded is transient", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: { code: 403, message: "Rate Limit Exceeded", errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }] } }, 403),
      );
      const err = await accessTokenFor("refresh-token-ratelimit", () => 4_000_000).catch((e) => e);
      expect(err).toBeInstanceOf(GoogleApiError);
      expect((err as GoogleApiError).kind).toBe("transient");
    });

    it("a 403 with reason insufficientPermissions is permanent", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 403, message: "Insufficient Permission", errors: [{ domain: "global", reason: "insufficientPermissions" }] } },
          403,
        ),
      );
      const err = await accessTokenFor("refresh-token-permission", () => 5_000_000).catch((e) => e);
      expect(err).toBeInstanceOf(GoogleApiError);
      expect((err as GoogleApiError).kind).toBe("permanent");
    });
  });

  describe("freeBusy", () => {
    it("posts timeMin/timeMax/items and merges every calendar's busy entries by start order", async () => {
      const from = new Date("2026-09-20T00:00:00.000Z");
      const to = new Date("2026-09-21T00:00:00.000Z");
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          calendars: {
            "cal1@example.com": { busy: [{ start: "2026-09-20T10:00:00.000Z", end: "2026-09-20T10:30:00.000Z" }] },
            "cal2@example.com": { busy: [{ start: "2026-09-20T09:00:00.000Z", end: "2026-09-20T09:30:00.000Z" }] },
          },
        }),
      );

      const busy = await freeBusy(ACCESS_TOKEN, ["cal1@example.com", "cal2@example.com"], from, to);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://www.googleapis.com/calendar/v3/freeBusy");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.timeMin).toBe(from.toISOString());
      expect(body.timeMax).toBe(to.toISOString());
      expect(body.items).toEqual([{ id: "cal1@example.com" }, { id: "cal2@example.com" }]);

      expect(busy).toHaveLength(2);
      expect(busy[0].start).toEqual(new Date("2026-09-20T09:00:00.000Z"));
      expect(busy[0].end).toEqual(new Date("2026-09-20T09:30:00.000Z"));
      expect(busy[1].start).toEqual(new Date("2026-09-20T10:00:00.000Z"));
      expect(busy[1].end).toEqual(new Date("2026-09-20T10:30:00.000Z"));
    });

    it("throws a permanent GoogleApiError when a calendar entry carries an errors array", async () => {
      const from = new Date("2026-09-20T00:00:00.000Z");
      const to = new Date("2026-09-21T00:00:00.000Z");
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          calendars: {
            "cal1@example.com": { errors: [{ domain: "global", reason: "notFound" }] },
          },
        }),
      );

      const err = await freeBusy(ACCESS_TOKEN, ["cal1@example.com"], from, to).catch((e) => e);

      expect(err).toBeInstanceOf(GoogleApiError);
      expect((err as GoogleApiError).kind).toBe("permanent");
    });
  });

  describe("insertEvent", () => {
    it("posts to /calendars/{id}/events with the conference request, attendee and dateTimes", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: "event-created-id" }));

      const start = new Date("2026-09-22T15:00:00.000Z");
      const end = new Date("2026-09-22T15:30:00.000Z");
      const result = await insertEvent(ACCESS_TOKEN, "app-calendar@group.calendar.google.com", {
        summary: "Meeting with a lead",
        description: "Booked via Funnel McQueen CRM",
        start,
        end,
        timeZone: "America/Chicago",
        attendeeEmails: ["agent@funnelmcqueen.test", "lead@example.com"],
        conferenceRequestId: "booking-request-id-123",
      });

      expect(result).toEqual({ id: "event-created-id" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe(
        "https://www.googleapis.com/calendar/v3/calendars/app-calendar%40group.calendar.google.com/events",
      );
      expect(parsed.searchParams.get("conferenceDataVersion")).toBe("1");
      expect(parsed.searchParams.get("sendUpdates")).toBe("all");
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.summary).toBe("Meeting with a lead");
      expect(body.description).toBe("Booked via Funnel McQueen CRM");
      expect(body.start).toEqual({ dateTime: start.toISOString(), timeZone: "America/Chicago" });
      expect(body.end).toEqual({ dateTime: end.toISOString(), timeZone: "America/Chicago" });
      expect(body.attendees).toEqual([{ email: "agent@funnelmcqueen.test" }, { email: "lead@example.com" }]);
      const conferenceData = body.conferenceData as { createRequest: { requestId: string; conferenceSolutionKey: { type: string } } };
      expect(conferenceData.createRequest.requestId).toBe("booking-request-id-123");
      expect(conferenceData.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
    });

    it("omits attendees when there are none", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: "event-no-attendee" }));

      await insertEvent(ACCESS_TOKEN, "app-calendar@group.calendar.google.com", {
        summary: "Meeting",
        description: "desc",
        start: new Date("2026-09-22T15:00:00.000Z"),
        end: new Date("2026-09-22T15:30:00.000Z"),
        timeZone: "America/Chicago",
        attendeeEmails: [],
        conferenceRequestId: "req-id",
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.attendees).toBeUndefined();
    });
  });

  describe("deleteEvent", () => {
    it.each([204, 404, 410])("returns normally on %d", async (status) => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status }));
      await expect(deleteEvent(ACCESS_TOKEN, "cal-id", "event-id")).resolves.toBeUndefined();
    });

    it("throws on 500", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 500, message: "Internal error" } }, 500));
      const err = await deleteEvent(ACCESS_TOKEN, "cal-id", "event-id").catch((e) => e);
      expect(err).toBeInstanceOf(GoogleApiError);
    });

    it("URL-encodes the calendar id and event id", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await deleteEvent(ACCESS_TOKEN, "cal id/with slash", "event id");
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent("cal id/with slash")}/events/${encodeURIComponent("event id")}`,
      );
    });
  });

  describe("createAppCalendar", () => {
    it("posts summary and timeZone to /calendars and returns the id", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: "new-app-calendar-id" }));

      const result = await createAppCalendar(ACCESS_TOKEN, "Funnel McQueen meetings", "America/Chicago");

      expect(result).toEqual({ id: "new-app-calendar-id" });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).toEqual({ summary: "Funnel McQueen meetings", timeZone: "America/Chicago" });
    });
  });

  describe("accountEmail", () => {
    it("reads the userinfo endpoint and returns the email", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ email: "closer@example.com", email_verified: true }));

      const email = await accountEmail(ACCESS_TOKEN);

      expect(email).toBe("closer@example.com");
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://www.googleapis.com/oauth2/v3/userinfo");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    });
  });

  describe("timeouts", () => {
    it("aborts after GOOGLE_TIMEOUT_MS, retries once, and throws a transient error", async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(() => new Promise(() => {}));

      const promise = freeBusy(ACCESS_TOKEN, ["cal@example.com"], new Date(), new Date());
      const expectation = expect(promise).rejects.toMatchObject({ kind: "transient" });

      await vi.advanceTimersByTimeAsync(GOOGLE_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(GOOGLE_TIMEOUT_MS);

      await expectation;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("retries", () => {
    it("retries exactly once on a connection error (TypeError)", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockRejectedValueOnce(new TypeError("fetch failed"));

      const err = await accountEmail(ACCESS_TOKEN).catch((e) => e);

      expect(err).toBeInstanceOf(GoogleApiError);
      expect((err as GoogleApiError).kind).toBe("transient");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("recovers when the retry succeeds", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(jsonResponse({ email: "recovered@example.com" }));

      const email = await accountEmail(ACCESS_TOKEN);

      expect(email).toBe("recovered@example.com");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("never retries a 400", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 400, message: "Bad Request" } }, 400));

      const err = await accountEmail(ACCESS_TOKEN).catch((e) => e);

      expect(err).toBeInstanceOf(GoogleApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("secrets discipline", () => {
    it("never logs and never includes the client secret or refresh token in a thrown error message", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const refreshToken = "test-refresh-token-super-secret-value";
      const clientSecret = "test-client-secret";
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          {
            error: "invalid_grant",
            error_description: `refresh token ${refreshToken} rejected for client secret ${clientSecret}`,
          },
          400,
        ),
      );

      const err = (await accessTokenFor(refreshToken, () => 6_000_000).catch((e) => e)) as GoogleApiError;

      expect(err).toBeInstanceOf(GoogleApiError);
      expect(err.message).not.toContain(refreshToken);
      expect(err.message).not.toContain(clientSecret);
      expect(err.reason).not.toContain(refreshToken);
      expect(err.reason).not.toContain(clientSecret);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});

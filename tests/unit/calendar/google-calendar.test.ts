// The Google-backed CalendarClient (docs/DEVIATIONS.md D47): windows built from bookable hours, busy time and
// meeting creation read from Google, errors mapped to onInvalidGrant, and never anything from Google beyond busy
// times and the created event id. The Task 4 HTTP layer (src/server/google/api.ts) is stubbed throughout — no
// test here may reach the network. The refresh-token ciphertext below is produced by the real encryptRefreshToken
// with an obvious fake key (32 zero bytes, base64), never a real value.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookableRange } from "@/lib/domain/bookable-hours";
import { resolveGoogleCalendar as resolveGoogleCalendarFromClient } from "@/server/calendar/client";
import { createGoogleCalendar, type GoogleCalendarConnection, type GoogleCalendarDeps } from "@/server/calendar/google";
import { resetEnvCacheForTests } from "@/server/env";
import { encryptRefreshToken } from "@/server/google/crypto";

vi.mock("@/server/google/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/google/api")>();
  return {
    ...actual,
    accessTokenFor: vi.fn(),
    freeBusy: vi.fn(),
    insertEvent: vi.fn(),
    deleteEvent: vi.fn(),
  };
});

import { accessTokenFor, deleteEvent, freeBusy, GoogleApiError, insertEvent } from "@/server/google/api";

const BASE_ENV = {
  NODE_ENV: "test",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321/",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
};

const ENCRYPTION_KEY = Buffer.alloc(32, 0).toString("base64");
const REFRESH_TOKEN = "test-refresh-token";
const ACCESS_TOKEN = "test-access-token";
const TIME_ZONE = "America/New_York";
const AGENT_CALENDAR_ID = "agent-cal-1";

// Monday 2026-09-21, 10:00-12:00 local (same shape mock-calendar.test.ts's WEEK/WINDOWS use).
const RANGES: readonly BookableRange[] = [{ weekday: 1, startsMinute: 600, endsMinute: 720 }];
const FROM = new Date("2026-09-21T04:00:00Z");
const TO = new Date("2026-09-22T04:00:00Z");

function makeConnection(overrides: Partial<GoogleCalendarConnection> = {}): GoogleCalendarConnection {
  return {
    refreshTokenCiphertext: encryptRefreshToken(REFRESH_TOKEN, ENCRYPTION_KEY),
    calendarId: AGENT_CALENDAR_ID,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<GoogleCalendarDeps> = {}) {
  const onInvalidGrant = vi.fn(async () => {});
  const deps: GoogleCalendarDeps = {
    connection: makeConnection(),
    ranges: RANGES,
    timeZone: TIME_ZONE,
    onInvalidGrant,
    ...overrides,
  };
  return { deps, onInvalidGrant };
}

beforeEach(() => {
  for (const [key, value] of Object.entries({ ...BASE_ENV, GOOGLE_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY })) vi.stubEnv(key, value);
  resetEnvCacheForTests();
  vi.mocked(accessTokenFor).mockReset().mockResolvedValue(ACCESS_TOKEN);
  vi.mocked(freeBusy).mockReset();
  vi.mocked(insertEvent).mockReset();
  vi.mocked(deleteEvent).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
});

describe("createGoogleCalendar", () => {
  describe("readAvailability", () => {
    it("returns windows built from the ranges and busy intervals exactly as freeBusy returned them, with no other fields", async () => {
      vi.mocked(freeBusy).mockResolvedValueOnce([{ start: new Date("2026-09-21T15:00:00Z"), end: new Date("2026-09-21T15:30:00Z") }]);
      const { deps } = makeDeps();

      const result = await createGoogleCalendar(deps).readAvailability({ from: FROM, to: TO });

      expect(result.windows[0]?.start.toISOString()).toBe("2026-09-21T14:00:00.000Z");
      expect(result.windows[0]).toEqual({ start: new Date("2026-09-21T14:00:00Z"), end: new Date("2026-09-21T16:00:00Z") });
      expect(result.busy).toEqual([{ start: new Date("2026-09-21T15:00:00Z"), end: new Date("2026-09-21T15:30:00Z") }]);
      expect(Object.keys(result.busy[0] ?? {})).toEqual(["start", "end"]);
      expect(Object.keys(result.windows[0] ?? {})).toEqual(["start", "end"]);
    });

    it("queries free/busy for the booking agent's own calendar and nothing else", async () => {
      vi.mocked(freeBusy).mockResolvedValue([]);
      const { deps } = makeDeps();

      await createGoogleCalendar(deps).readAvailability({ from: FROM, to: TO });
      // Not the owner's primary calendar: they do not attend these meetings, so their commitments must not
      // block an agent, and the app must not read their personal calendar at all (D48).
      expect(freeBusy).toHaveBeenCalledWith(ACCESS_TOKEN, [AGENT_CALENDAR_ID], FROM, TO);
    });
  });

  describe("createMeeting", () => {
    const start = new Date("2026-09-21T14:00:00Z");
    const end = new Date("2026-09-21T14:30:00Z");

    it("calls insertEvent with the app calendar id, the given title/description, the closer's time zone, and the attendee only with a lead email", async () => {
      vi.mocked(insertEvent).mockResolvedValueOnce({ id: "event-1" });
      const { deps } = makeDeps();

      // A variable (not an inline literal) so the extra `leadEmail`/`clientRequestId` fields — carried by the
      // Google client's own wider input type but not by the narrower CalendarClient interface this value is
      // statically typed as — do not trip TypeScript's excess-property check; the real object still carries
      // them at runtime.
      const input = {
        start,
        end,
        title: "Meeting: Swan Motel",
        description: "Contact: Jane",
        leadEmail: "lead@example.com",
        clientRequestId: "11111111-1111-4111-8111-111111111111",
      };
      const result = await createGoogleCalendar(deps).createMeeting(input);

      expect(result).toEqual({ eventId: "event-1" });
      expect(insertEvent).toHaveBeenCalledTimes(1);
      const [accessToken, calendarId, event] = vi.mocked(insertEvent).mock.calls[0]!;
      expect(accessToken).toBe(ACCESS_TOKEN);
      expect(calendarId).toBe(AGENT_CALENDAR_ID);
      expect(event).toMatchObject({
        summary: "Meeting: Swan Motel",
        description: "Contact: Jane",
        start,
        end,
        timeZone: TIME_ZONE,
        attendeeEmail: "lead@example.com",
      });
    });

    it("derives the Meet conference's request id from the booking's client request id, so a retry of the same booking cannot create a second conference", async () => {
      vi.mocked(insertEvent).mockResolvedValueOnce({ id: "event-1" });
      const { deps } = makeDeps();

      const clientRequestId = "22222222-2222-4222-8222-222222222222";
      const input = { start, end, title: "t", description: "d", leadEmail: null, clientRequestId };
      await createGoogleCalendar(deps).createMeeting(input);

      const [, , event] = vi.mocked(insertEvent).mock.calls[0]!;
      expect(event.conferenceRequestId).toBe(clientRequestId);
    });

    it("passes no attendee when the input carries no lead email", async () => {
      vi.mocked(insertEvent).mockResolvedValueOnce({ id: "event-2" });
      const { deps } = makeDeps();

      const input = { start, end, title: "t", description: "d", leadEmail: null, clientRequestId: "33333333-3333-4333-8333-333333333333" };
      await createGoogleCalendar(deps).createMeeting(input);

      const [, , event] = vi.mocked(insertEvent).mock.calls[0]!;
      expect(event.attendeeEmail).toBeNull();
    });
  });

  describe("error mapping", () => {
    it("invokes onInvalidGrant once and rethrows a GoogleApiError with kind invalid_grant", async () => {
      const error = new GoogleApiError("invalid_grant", 400, "invalid_grant");
      vi.mocked(freeBusy).mockRejectedValueOnce(error);
      const { deps, onInvalidGrant } = makeDeps();

      await expect(createGoogleCalendar(deps).readAvailability({ from: FROM, to: TO })).rejects.toBe(error);
      expect(onInvalidGrant).toHaveBeenCalledTimes(1);
    });

    it("rethrows a transient error without calling onInvalidGrant", async () => {
      const error = new GoogleApiError("transient", 503, "backendError");
      vi.mocked(freeBusy).mockRejectedValueOnce(error);
      const { deps, onInvalidGrant } = makeDeps();

      await expect(createGoogleCalendar(deps).readAvailability({ from: FROM, to: TO })).rejects.toBe(error);
      expect(onInvalidGrant).not.toHaveBeenCalled();
    });

    it("invokes onInvalidGrant when the stored refresh token cannot be decrypted (wrong/rotated key), before ever calling Google", async () => {
      const { deps, onInvalidGrant } = makeDeps({ connection: makeConnection({ refreshTokenCiphertext: "not-a-real-ciphertext" }) });

      await expect(createGoogleCalendar(deps).readAvailability({ from: FROM, to: TO })).rejects.toThrow(/not readable/);
      expect(onInvalidGrant).toHaveBeenCalledTimes(1);
      expect(accessTokenFor).not.toHaveBeenCalled();
      expect(freeBusy).not.toHaveBeenCalled();
    });
  });

  describe("cancelMeeting", () => {
    it("delegates to deleteEvent with the app calendar id", async () => {
      vi.mocked(deleteEvent).mockResolvedValueOnce(undefined);
      const { deps } = makeDeps();

      await createGoogleCalendar(deps).cancelMeeting("event-9");

      expect(deleteEvent).toHaveBeenCalledWith(ACCESS_TOKEN, AGENT_CALENDAR_ID, "event-9");
    });
  });
});

describe("resolveGoogleCalendar (client.ts)", () => {
  it("resolves a working CalendarClient for an already-loaded connection and ranges", async () => {
    vi.mocked(freeBusy).mockResolvedValueOnce([]);
    const { deps } = makeDeps();

    const client = resolveGoogleCalendarFromClient(deps);
    const result = await client.readAvailability({ from: FROM, to: TO });

    expect(result.windows).toHaveLength(1);
  });
});

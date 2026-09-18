// The Google-backed CalendarClient (docs/DEVIATIONS.md D47). This is the privacy boundary for this milestone: it
// must never call an events-listing endpoint (the granted scopes do not allow one) and must never return anything
// from Google beyond bare busy start/end times and the created event's id — no title, description or attendee.
// The database is out of scope here: the caller (src/server/services/calendar-connection.ts, Task 6/7) reads the
// connection row and the bookable hours and passes them in through GoogleCalendarDeps.
import "server-only";
import { randomUUID } from "node:crypto";
import { bookableWindows, type BookableRange } from "@/lib/domain/bookable-hours";
import { accessTokenFor, deleteEvent, freeBusy, GoogleApiError, insertEvent } from "@/server/google/api";
import { decryptRefreshToken } from "@/server/google/crypto";
import type { CalendarAvailability, CalendarClient, CalendarInterval } from "./types";

/** A connected account, as stored (ciphertext only — never the raw refresh token). */
export interface GoogleCalendarConnection {
  readonly refreshTokenCiphertext: string;
  readonly googleEmail: string;
  /** The secondary calendar the app writes meetings to (design §3). Null until `ensureAppCalendar` creates one. */
  readonly appCalendarId: string | null;
}

export interface GoogleCalendarDeps {
  connection: GoogleCalendarConnection;
  ranges: readonly BookableRange[];
  /** The closer's zone: bookable hours are interpreted in it, and it is sent with every created event. */
  timeZone: string;
  /** Called once when any Google call fails with GoogleApiError kind "invalid_grant" (access revoked). */
  onInvalidGrant: () => Promise<void>;
  /**
   * The connection's app calendar id, creating it (via `createAppCalendar` and `connect_calendar`, Task 7) when
   * the connection has none yet, and just returning it when one already exists.
   */
  ensureAppCalendar: () => Promise<string>;
}

/** createMeeting's input, widened with the optional lead email the CalendarClient interface itself does not carry. */
interface CreateMeetingInput {
  start: Date;
  end: Date;
  title: string;
  description: string;
  leadEmail?: string | null;
}

/**
 * Runs one Google call chain: decrypts the refresh token, exchanges it for an access token, then `fn`. A
 * GoogleApiError with kind "invalid_grant" reports the connection broken through `onInvalidGrant` (once) before
 * rethrowing; every other error — including a plain decrypt failure — rethrows untouched.
 */
async function withAccessToken<T>(deps: GoogleCalendarDeps, fn: (accessToken: string) => Promise<T>): Promise<T> {
  try {
    const refreshToken = decryptRefreshToken(deps.connection.refreshTokenCiphertext);
    const accessToken = await accessTokenFor(refreshToken);
    return await fn(accessToken);
  } catch (err) {
    if (err instanceof GoogleApiError && err.kind === "invalid_grant") {
      await deps.onInvalidGrant();
    }
    throw err;
  }
}

/** The connection's app calendar id, creating it through `ensureAppCalendar` first when there is none yet. */
async function resolveAppCalendarId(deps: GoogleCalendarDeps): Promise<string> {
  if (deps.connection.appCalendarId) return deps.connection.appCalendarId;
  return deps.ensureAppCalendar();
}

export function createGoogleCalendar(deps: GoogleCalendarDeps): CalendarClient & { cancelMeeting(eventId: string): Promise<void> } {
  return {
    async readAvailability({ from, to }): Promise<CalendarAvailability> {
      const windows: CalendarInterval[] = bookableWindows(deps.ranges, deps.timeZone, from, to).map((window) => ({
        start: window.start,
        end: window.end,
      }));
      const calendarIds = deps.connection.appCalendarId
        ? [deps.connection.googleEmail, deps.connection.appCalendarId]
        : [deps.connection.googleEmail];
      const busyTimes = await withAccessToken(deps, (accessToken) => freeBusy(accessToken, calendarIds, from, to));
      const busy: CalendarInterval[] = busyTimes.map((block) => ({ start: block.start, end: block.end }));
      return { windows, busy };
    },

    async createMeeting(input: CreateMeetingInput): Promise<{ eventId: string }> {
      return withAccessToken(deps, async (accessToken) => {
        const calendarId = await resolveAppCalendarId(deps);
        const { id } = await insertEvent(accessToken, calendarId, {
          summary: input.title,
          description: input.description,
          start: input.start,
          end: input.end,
          timeZone: deps.timeZone,
          attendeeEmail: input.leadEmail ?? null,
          conferenceRequestId: randomUUID(),
        });
        return { eventId: id };
      });
    },

    async cancelMeeting(eventId: string): Promise<void> {
      return withAccessToken(deps, async (accessToken) => {
        const calendarId = await resolveAppCalendarId(deps);
        await deleteEvent(accessToken, calendarId, eventId);
      });
    },
  };
}

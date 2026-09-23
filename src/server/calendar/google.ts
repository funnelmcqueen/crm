// The Google-backed CalendarClient (docs/DEVIATIONS.md D47). This is the privacy boundary for this milestone: it
// must never call an events-listing endpoint (the granted scopes do not allow one) and must never return anything
// from Google beyond bare busy start/end times and the created event's id — no title, description or attendee.
// The database is out of scope here: the caller (src/server/services/calendar-booking.ts) reads the connection
// row and the bookable hours and passes them in through GoogleCalendarDeps.
//
// The app calendar is always already created by the time this module ever sees a connection: the OAuth connect
// flow (src/server/http/google-oauth.ts) creates it and stores its id in the same write that creates the
// connection row, so there is no "connection with no app calendar id" state for this module to handle. An
// earlier version of this contract had this module create the calendar lazily on first use; that was dropped
// (fix round 1) because a `connect_calendar` rejection after the calendar was created would orphan it on the
// closer's account, and because the RPC is admin-only, so a lazy create triggered by an agent's own booking
// session would just raise forbidden.
import "server-only";
import { bookableWindows, type BookableRange } from "@/lib/domain/bookable-hours";
import { accessTokenFor, deleteEvent, freeBusy, GoogleApiError, insertEvent } from "@/server/google/api";
import { decryptRefreshToken } from "@/server/google/crypto";
import type { CalendarAvailability, CalendarClient, CalendarInterval } from "./types";

/** A connected account, as stored (ciphertext only — never the raw refresh token). */
export interface GoogleCalendarConnection {
  readonly refreshTokenCiphertext: string;
  readonly googleEmail: string;
  /** The secondary calendar the app writes meetings to (design §3), created before the connection is stored. */
  readonly appCalendarId: string;
}

export interface GoogleCalendarDeps {
  connection: GoogleCalendarConnection;
  ranges: readonly BookableRange[];
  /** The closer's zone: bookable hours are interpreted in it, and it is sent with every created event. */
  timeZone: string;
  /** Called once when any Google call fails with GoogleApiError kind "invalid_grant" (access revoked). */
  onInvalidGrant: () => Promise<void>;
}

/**
 * createMeeting's input, widened with fields the CalendarClient interface itself does not carry: the optional
 * lead email, and the booking's own client request id (design §7) — the Meet conference's request id is derived
 * from it so that the mandated single retry of events.insert (src/server/google/api.ts) cannot create a second
 * conference: a timed-out insert Google actually processed and a retry of the same booking attempt carry the
 * same clientRequestId, so Google recognises the same conference request instead of creating another one.
 */
interface CreateMeetingInput {
  start: Date;
  end: Date;
  title: string;
  description: string;
  leadEmail?: string | null;
  clientRequestId: string;
}

/**
 * Runs one Google call chain: decrypts the refresh token, exchanges it for an access token, then `fn`. A
 * GoogleApiError with kind "invalid_grant" reports the connection broken through `onInvalidGrant` (once) before
 * rethrowing; every other Google/network error rethrows untouched.
 *
 * A decrypt failure (GOOGLE_TOKEN_ENCRYPTION_KEY rotated or wrong in this environment, or a tampered ciphertext)
 * is deliberately treated the same as invalid_grant: it also reports the connection broken. Otherwise Settings
 * keeps showing "Connected" while booking is silently unavailable and nothing ever points the owner at the real
 * cause — reconnecting genuinely is the fix either way, since it re-encrypts the refresh token under whatever
 * key is current. The decrypt call is isolated in its own try/catch so this only ever fires for a
 * decrypt failure, never for a later, unrelated error from accessTokenFor or `fn`.
 */
async function withAccessToken<T>(deps: GoogleCalendarDeps, fn: (accessToken: string) => Promise<T>): Promise<T> {
  let refreshToken: string;
  try {
    refreshToken = decryptRefreshToken(deps.connection.refreshTokenCiphertext);
  } catch (err) {
    await deps.onInvalidGrant();
    throw err;
  }
  try {
    const accessToken = await accessTokenFor(refreshToken);
    return await fn(accessToken);
  } catch (err) {
    if (err instanceof GoogleApiError && err.kind === "invalid_grant") {
      await deps.onInvalidGrant();
    }
    throw err;
  }
}

export function createGoogleCalendar(deps: GoogleCalendarDeps): CalendarClient & { cancelMeeting(eventId: string): Promise<void> } {
  return {
    async readAvailability({ from, to }): Promise<CalendarAvailability> {
      const windows: CalendarInterval[] = bookableWindows(deps.ranges, deps.timeZone, from, to).map((window) => ({
        start: window.start,
        end: window.end,
      }));
      const calendarIds = [deps.connection.googleEmail, deps.connection.appCalendarId];
      const busyTimes = await withAccessToken(deps, (accessToken) => freeBusy(accessToken, calendarIds, from, to));
      const busy: CalendarInterval[] = busyTimes.map((block) => ({ start: block.start, end: block.end }));
      return { windows, busy };
    },

    async createMeeting(input: CreateMeetingInput): Promise<{ eventId: string }> {
      return withAccessToken(deps, async (accessToken) => {
        const { id } = await insertEvent(accessToken, deps.connection.appCalendarId, {
          summary: input.title,
          description: input.description,
          start: input.start,
          end: input.end,
          timeZone: deps.timeZone,
          attendeeEmail: input.leadEmail ?? null,
          conferenceRequestId: input.clientRequestId,
        });
        return { eventId: id };
      });
    },

    async cancelMeeting(eventId: string): Promise<void> {
      return withAccessToken(deps, async (accessToken) => {
        await deleteEvent(accessToken, deps.connection.appCalendarId, eventId);
      });
    },
  };
}

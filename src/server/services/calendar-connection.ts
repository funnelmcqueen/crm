// Google Calendar connection status, bookable hours and disconnecting (docs/DEVIATIONS.md D47). Every read
// and write here runs with the caller's own session, except the one place that needs the refresh token
// ciphertext to revoke it with Google (calendar_connection is locked down from every API role, admin
// included — see supabase/migrations/20260915002000_google_calendar.sql).
import { z } from "zod";
import { type BookableRange, validateBookableRanges } from "@/lib/domain/bookable-hours";
import { requireActive, requireAdmin, type RequestContext } from "@/server/context";
import { AppError, mapPostgrestError, type PostgrestLikeError } from "@/server/errors";
import { accessTokenFor, createAppCalendar } from "@/server/google/api";
import { decryptRefreshToken } from "@/server/google/crypto";
import { revokeToken } from "@/server/google/oauth";
import { createAdminClient } from "@/server/supabase/admin";

function fail(error: PostgrestLikeError): never {
  throw mapPostgrestError(error);
}

// ---------------------------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------------------------

export interface CalendarConnectionStatus {
  connected: boolean;
  googleEmail: string | null;
  hoursSet: boolean;
  broken: boolean;
}

export async function getCalendarConnectionStatus(ctx: RequestContext | null): Promise<CalendarConnectionStatus> {
  const admin = requireAdmin(ctx);
  const { data, error } = await admin.supabase.rpc("get_calendar_status");
  if (error) fail(error);
  const row = data?.[0];
  if (!row) throw new AppError("internal");
  return { connected: row.connected, googleEmail: row.google_email, hoursSet: row.hours_set, broken: row.broken };
}

// ---------------------------------------------------------------------------------------------
// Bookable hours
// ---------------------------------------------------------------------------------------------

/** Reported when `set_bookable_hours` still refuses a row `validateBookableRanges` let through (defense in depth). */
const INVALID_HOURS_FALLBACK_MESSAGE = "Check the bookable hours and try again.";

export async function getBookableHours(ctx: RequestContext | null): Promise<BookableRange[]> {
  const active = requireActive(ctx);
  const { data, error } = await active.supabase
    .from("bookable_hours")
    .select("weekday, starts_minute, ends_minute")
    .order("weekday", { ascending: true })
    .order("starts_minute", { ascending: true });
  if (error) fail(error);
  return (data ?? []).map((row) => ({ weekday: row.weekday, startsMinute: row.starts_minute, endsMinute: row.ends_minute }));
}

const bookableRangeSchema = z
  .object({
    weekday: z.number(),
    startsMinute: z.number(),
    endsMinute: z.number(),
  })
  .strict();

const bookableRangesSchema = z.array(bookableRangeSchema).max(50);

export async function saveBookableHours(ctx: RequestContext | null, ranges: unknown): Promise<BookableRange[]> {
  const admin = requireAdmin(ctx);
  const parsed = bookableRangesSchema.parse(ranges);

  const message = validateBookableRanges(parsed);
  if (message) throw new AppError("validation", message);

  const { error } = await admin.supabase.rpc("set_bookable_hours", {
    p_rows: parsed.map((range) => ({ weekday: range.weekday, starts_minute: range.startsMinute, ends_minute: range.endsMinute })),
  });
  if (error) {
    if (error.code === "P0001" && error.message === "invalid_hours") {
      throw new AppError("validation", INVALID_HOURS_FALLBACK_MESSAGE);
    }
    fail(error);
  }
  return getBookableHours(admin);
}

// ---------------------------------------------------------------------------------------------
// Disconnecting
// ---------------------------------------------------------------------------------------------

/** The stored ciphertext, read with the service role since no API role — admin included — may select the row. */
async function loadRefreshTokenCiphertext(): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("calendar_connection")
    .select("refresh_token_ciphertext")
    .eq("id", true)
    .maybeSingle();
  if (error) fail(error);
  return data?.refresh_token_ciphertext ?? null;
}

export async function disconnectCalendar(ctx: RequestContext | null): Promise<void> {
  const admin = requireAdmin(ctx);

  const ciphertext = await loadRefreshTokenCiphertext();
  if (ciphertext) {
    try {
      // revokeToken itself is best effort and never throws; decrypting can, so this still needs a guard.
      await revokeToken(decryptRefreshToken(ciphertext));
    } catch (error) {
      console.error("[calendar-connection] revoking the Google token failed", { code: error instanceof Error ? error.name : typeof error });
    }
  }

  const { error } = await admin.supabase.rpc("disconnect_calendar");
  if (error) fail(error);
}

// ---------------------------------------------------------------------------------------------
// A calendar per agent (docs/DEVIATIONS.md D48)
// ---------------------------------------------------------------------------------------------

/** What an agent's calendar is called on the connected account, so it reads clearly beside the others there. */
export function meetingCalendarTitle(displayName: string): string {
  const name = displayName.trim();
  return name ? `${name} — meetings` : "Meetings";
}

/**
 * An access token for the connected account, or null when there is nothing to act on — nothing connected, or a
 * connection already marked broken. Read with the service role, like every other use of the ciphertext.
 */
async function connectedAccessToken(): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("calendar_connection")
    .select("refresh_token_ciphertext, broken_at")
    .eq("id", true)
    .maybeSingle();
  if (error) fail(error);
  if (!data || data.broken_at) return null;
  return accessTokenFor(decryptRefreshToken(data.refresh_token_ciphertext));
}

/**
 * Creates `userId`'s own calendar on the connected account and stores its id (D48), returning it. Null means
 * there was nothing to create it on — no connection, or one already marked broken — which is not an error here:
 * the calendar is provisioned from Settings once the account is connected, and until then that agent cannot book.
 *
 * A failure of the RPC after Google has created the calendar leaves an empty calendar on the account. It is
 * harmless and re-provisioning simply makes another, so this does not try to undo it; the RUNBOOK says to
 * delete strays by hand, next to the account-switch case.
 */
export async function provisionAgentCalendar(userId: string, displayName: string, timeZone: string): Promise<string | null> {
  const accessToken = await connectedAccessToken();
  if (!accessToken) return null;
  const { id } = await createAppCalendar(accessToken, meetingCalendarTitle(displayName), timeZone);
  const { error } = await createAdminClient().rpc("set_agent_calendar_id", { p_user_id: userId, p_calendar_id: id });
  if (error) {
    console.error("[calendar-connection] created a calendar but could not store it", { userId, code: error.code });
    fail(error);
  }
  return id;
}

export interface AgentCalendarRow {
  userId: string;
  name: string;
  email: string;
  hasCalendar: boolean;
}

/** Every active user and whether they can book yet — the Settings card's list. */
export async function listAgentCalendars(ctx: RequestContext | null): Promise<AgentCalendarRow[]> {
  const admin = requireAdmin(ctx);
  const { data, error } = await admin.supabase
    .from("profiles")
    .select("id, name, email, google_calendar_id")
    .is("deleted_at", null)
    .eq("active", true)
    .order("name", { ascending: true });
  if (error) fail(error);
  return (data ?? []).map((row) => ({
    userId: row.id,
    name: row.name || row.email,
    email: row.email,
    hasCalendar: row.google_calendar_id !== null,
  }));
}

const NOT_CONNECTED_MESSAGE = "Connect Google Calendar first, then give each person a calendar.";

/**
 * Gives one agent a calendar, for anyone who predates D48 or whose account was created before the connection
 * existed. Admin only, and provisioning is never reachable from an agent's own session (`set_agent_calendar_id`
 * is service-role only), so a booking cannot create calendars as a side effect.
 */
export async function provisionCalendarForAgent(ctx: RequestContext | null, userId: unknown): Promise<AgentCalendarRow[]> {
  const admin = requireAdmin(ctx);
  const parsed = z.uuid().safeParse(typeof userId === "string" ? userId.trim().toLowerCase() : userId);
  if (!parsed.success) throw new AppError("not_found");

  const { data: profile, error } = await admin.supabase
    .from("profiles")
    .select("id, name, email, timezone, google_calendar_id")
    .eq("id", parsed.data)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) fail(error);
  if (!profile) throw new AppError("not_found");
  // Already provisioned: making a second calendar would strand the first, with its meetings on it.
  if (profile.google_calendar_id) return listAgentCalendars(admin);

  const created = await provisionAgentCalendar(profile.id, profile.name || profile.email, profile.timezone);
  if (!created) throw new AppError("unavailable", NOT_CONNECTED_MESSAGE);
  return listAgentCalendars(admin);
}

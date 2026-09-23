// Closer calendar booking (docs/DEVIATIONS.md D46). Every query runs with the caller's session: appointments are read
// under RLS and written only through the guarded RPCs in 20260915001900_calendar_booking.sql.
//
// Privacy boundary: nothing from a calendar reaches the browser except start and end times. Intervals are rebuilt
// field by field below, so a client that hands back more (a title, attendees) still cannot leak it.
import { z } from "zod";
import { suggestSlots } from "@/lib/domain/business-rhythm";
import type { BookableRange } from "@/lib/domain/bookable-hours";
import {
  BOOKING_FAILED_MESSAGE,
  BOOKING_UNAVAILABLE_MESSAGE,
  CALENDAR_LOAD_FAILED_MESSAGE,
  SLOT_TAKEN_MESSAGE,
} from "@/lib/domain/booking-messages";
import { isBusinessType, resolveBusinessType, type BusinessType } from "@/lib/domain/business-type";
import { BOOKING_HORIZON_DAYS, SLOT_MS, freeSlots, intersectIntervals, mergeIntervals, type Interval } from "@/lib/domain/calendar-slots";
import { leadTimeZone } from "@/lib/domain/lead-timezone";
import { buildMeetingDescription, meetingTitle } from "@/lib/domain/meeting-description";
import { phraseSlot, yourTimeLine, zoneAbbreviation } from "@/lib/domain/slot-phrase";
import type { LeadStatus } from "@/lib/domain/statuses";
import { formatInTz } from "@/lib/domain/time";
import { isGoogleDriver, resolveCalendarClient, resolveGoogleCalendar } from "@/server/calendar/client";
import { createGoogleCalendar, type GoogleCalendarDeps } from "@/server/calendar/google";
import type { CalendarClient } from "@/server/calendar/types";
import { requireActive, type RequestContext } from "@/server/context";
import { getCalendarDriver, getServerEnv } from "@/server/env";
import { AppError, mapPostgrestError, type PostgrestLikeError } from "@/server/errors";
import { GoogleApiError } from "@/server/google/api";
import { updateLeadStatus } from "@/server/services/leads";
import { createAdminClient } from "@/server/supabase/admin";

const CACHE_TTL_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface CalendarDeps {
  /** undefined: the configured driver (cached). null: no calendar. A client: that client, never cached. */
  calendar?: CalendarClient | null;
  now?: () => Date;
}

export interface SlotView {
  start: string;
  end: string;
  /** yyyy-MM-dd on the lead's calendar. */
  day: string;
  phrase: string;
  zone: string;
  yourTime: string | null;
}

export interface IntervalView {
  start: string;
  end: string;
}

export interface MyMeetingView extends IntervalView {
  id: string;
  leadId: string;
  businessName: string;
}

export interface AgentAvailability {
  leadId: string;
  businessName: string;
  businessType: BusinessType;
  businessTypeIsGuess: boolean;
  leadTimeZone: string;
  leadTimeZoneIsGuess: boolean;
  /** Abbreviation of the lead's zone right now, e.g. "EDT". */
  zone: string;
  now: string;
  suggestions: SlotView[];
  slots: SlotView[];
  busy: IntervalView[];
  mine: MyMeetingView[];
}

function fail(error: PostgrestLikeError): never {
  throw mapPostgrestError(error);
}

const uuidSchema = z.uuid();

/** Malformed ids get the same answer as ids that do not exist. */
function parseId(value: unknown): string {
  const parsed = uuidSchema.safeParse(typeof value === "string" ? value.trim().toLowerCase() : value);
  if (!parsed.success) throw new AppError("not_found");
  return parsed.data;
}

async function closerTimeZone(ctx: RequestContext): Promise<string> {
  const { data } = await ctx.supabase.from("settings").select("default_timezone").limit(1).maybeSingle();
  return data?.default_timezone ?? "America/New_York";
}

interface GoogleConnectionRow {
  refreshTokenCiphertext: string;
  brokenAt: string | null;
}

/**
 * The agent's own calendar on the connected account (D48), or null when they have none yet — every agent who
 * predates D48, and anyone whose calendar could not be created with their account. Runs with the caller's own
 * session: under profiles_select an agent reads their own row and an admin reads all, which covers both callers
 * this has (an agent booking for themselves, and an admin cancelling someone else's meeting).
 */
async function loadAgentCalendarId(ctx: RequestContext, ownerId: string): Promise<string | null> {
  // Read, not taken from ctx.profile: that is a snapshot from the start of the request, and a calendar cleared
  // or provisioned in between must take effect on the next booking rather than the next sign-in.
  const { data, error } = await ctx.supabase.from("profiles").select("google_calendar_id").eq("id", ownerId).maybeSingle();
  if (error) fail(error);
  return data?.google_calendar_id ?? null;
}

/**
 * The raw connection row, ciphertext included. `calendar_connection` is locked down from every API role (see
 * the migration), so this is the one place in the booking path that needs the service role rather than the
 * caller's own session (docs/DEVIATIONS.md D47).
 */
async function loadGoogleConnection(): Promise<GoogleConnectionRow | null> {
  const { data, error } = await createAdminClient()
    .from("calendar_connection")
    .select("refresh_token_ciphertext, broken_at")
    .eq("id", true)
    .maybeSingle();
  if (error) fail(error);
  if (!data) return null;
  return { refreshTokenCiphertext: data.refresh_token_ciphertext, brokenAt: data.broken_at };
}

/** Any active user may read the bookable hours (RLS), so this runs with the caller's own session. */
async function loadBookableRanges(ctx: RequestContext): Promise<BookableRange[]> {
  const { data, error } = await ctx.supabase.from("bookable_hours").select("weekday, starts_minute, ends_minute");
  if (error) fail(error);
  return (data ?? []).map((row) => ({ weekday: row.weekday, startsMinute: row.starts_minute, endsMinute: row.ends_minute }));
}

/**
 * Best effort: a failure here is logged, and the invalid_grant that triggered it still surfaces to the caller.
 * mark_calendar_broken is service-role only (any active user's booking attempt can trigger this call, but the
 * call itself must not be reachable from an agent's own session — see the migration), so this runs through the
 * admin client, the same way loadGoogleConnection does.
 */
async function markCalendarBroken(): Promise<void> {
  const { error } = await createAdminClient().rpc("mark_calendar_broken");
  if (error) console.error("[booking] mark_calendar_broken failed", { code: error.code });
}

/**
 * The Google deps for `ownerId`'s calendar on an already-connected, working account, or null when it is not
 * usable — no connection row, one already marked broken (short-circuited here so a connection known to be dead
 * never pays a Google round trip that is guaranteed to fail — fix round 1), or an agent with no calendar of
 * their own yet (D48). Shared by the normal availability/booking path (through `resolveGoogleCalendar`) and
 * `cancelAppointment`'s / a failed `confirm_appointment`'s event delete (through `createGoogleCalendar`
 * directly, for its `cancelMeeting`).
 */
async function buildGoogleDeps(ctx: RequestContext, timeZone: string, ownerId: string): Promise<GoogleCalendarDeps | null> {
  const row = await loadGoogleConnection();
  if (!row || row.brokenAt) return null;
  const calendarId = await loadAgentCalendarId(ctx, ownerId);
  if (!calendarId) {
    // Booking is simply unavailable to this agent until an admin provisions their calendar in Settings. Logged
    // because it is the one cause of "booking isn't available" that an otherwise healthy connection can produce.
    console.error("[booking] agent has no calendar", { ownerId, reason: "no_agent_calendar" });
    return null;
  }
  const ranges = await loadBookableRanges(ctx);
  return {
    connection: { refreshTokenCiphertext: row.refreshTokenCiphertext, calendarId },
    ranges,
    timeZone,
    onInvalidGrant: () => markCalendarBroken(),
  };
}

async function defaultCalendar(ctx: RequestContext, ownerId: string): Promise<CalendarClient | null> {
  const timeZone = await closerTimeZone(ctx);
  let driver: ReturnType<typeof getCalendarDriver>;
  try {
    driver = getCalendarDriver();
  } catch {
    return null;
  }
  if (driver !== "google") return resolveCalendarClient(timeZone, ownerId);
  const deps = await buildGoogleDeps(ctx, timeZone, ownerId);
  return deps ? resolveGoogleCalendar(deps) : null;
}

/** `ownerId` is whose calendar this is — the booking agent, which is the caller on every path that books. */
export async function calendarFor(ctx: RequestContext, ownerId: string, deps: CalendarDeps): Promise<CalendarClient> {
  const calendar = deps.calendar !== undefined ? deps.calendar : await defaultCalendar(ctx, ownerId);
  if (!calendar) throw new AppError("unavailable", BOOKING_UNAVAILABLE_MESSAGE);
  return calendar;
}

// Best effort and per server instance: correctness comes from the re-check when booking. Keyed by the owner as
// well as the range since D48 — each agent reads their own calendar, so a single range-keyed entry would serve
// one agent another's windows and busy times, which is both wrong and a leak.
let cache: { key: string; expires: number; windows: Interval[]; busy: Interval[] } | null = null;

export async function readCalendar(
  calendar: CalendarClient,
  ownerId: string,
  from: Date,
  to: Date,
  useCache: boolean,
): Promise<{ windows: Interval[]; busy: Interval[] }> {
  const key = `${ownerId}|${from.toISOString()}|${to.toISOString()}`;
  if (useCache && cache && cache.key === key && cache.expires > Date.now()) {
    return { windows: cache.windows, busy: cache.busy };
  }
  let read: Awaited<ReturnType<CalendarClient["readAvailability"]>>;
  try {
    read = await calendar.readAvailability({ from, to });
  } catch (error) {
    console.error("[booking] readAvailability failed", { code: error instanceof Error ? error.name : typeof error });
    // invalid_grant already marked the connection broken (onInvalidGrant, above); the agent still just sees
    // booking as unavailable, same as a not-yet-connected calendar.
    if (error instanceof GoogleApiError && error.kind === "invalid_grant") {
      throw new AppError("unavailable", BOOKING_UNAVAILABLE_MESSAGE, { cause: error });
    }
    throw new AppError("unavailable", CALENDAR_LOAD_FAILED_MESSAGE, { cause: error });
  }
  const windows = read.windows.map((window) => ({ start: new Date(window.start), end: new Date(window.end) }));
  const busy = read.busy.map((block) => ({ start: new Date(block.start), end: new Date(block.end) }));
  if (useCache) cache = { key, expires: Date.now() + CACHE_TTL_MS, windows, busy };
  return { windows, busy };
}

async function myMeetings(ctx: RequestContext, now: Date): Promise<MyMeetingView[]> {
  const { data, error } = await ctx.supabase
    .from("appointments")
    .select("id, lead_id, starts_at, ends_at")
    .eq("booked_by", ctx.userId)
    .eq("status", "scheduled")
    .gt("ends_at", now.toISOString())
    .order("starts_at", { ascending: true })
    .limit(200);
  if (error) fail(error);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const { data: leads, error: leadsError } = await ctx.supabase
    .from("leads")
    .select("id, business_name")
    .in("id", [...new Set(rows.map((row) => row.lead_id))]);
  if (leadsError) fail(leadsError);
  const names = new Map((leads ?? []).map((lead) => [lead.id, lead.business_name]));
  return rows.map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    start: new Date(row.starts_at).toISOString(),
    end: new Date(row.ends_at).toISOString(),
    businessName: names.get(row.lead_id) ?? "A lead no longer assigned to you",
  }));
}

export async function getAgentAvailability(
  ctx: RequestContext | null,
  leadId: unknown,
  deps: CalendarDeps = {},
): Promise<AgentAvailability> {
  const active = requireActive(ctx);
  const id = parseId(leadId);
  const { data: lead, error } = await active.supabase
    .from("leads")
    .select("id, business_name, state, country, business_type")
    .eq("id", id)
    .maybeSingle();
  if (error) fail(error);
  if (!lead) throw new AppError("not_found");

  const calendar = await calendarFor(active, active.userId, deps);
  const now = deps.now?.() ?? new Date();
  // Whole-hour range: requests within the same hour share one cache entry.
  const from = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const to = new Date(from.getTime() + (BOOKING_HORIZON_DAYS + 1) * DAY_MS);
  const read = await readCalendar(calendar, active.userId, from, to, deps.calendar === undefined);

  const { data: booked, error: bookedError } = await active.supabase.rpc("booked_intervals", {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (bookedError) fail(bookedError);

  const busy = mergeIntervals([
    ...read.busy,
    ...(booked ?? []).map((row) => ({ start: new Date(row.starts_at), end: new Date(row.ends_at) })),
  ]);
  // freeSlots below always uses this unclipped busy list. Only the browser-facing `busy` field further down is
  // narrowed to the bookable windows — the picker has no use for the closer's evenings, nights and weekends,
  // and a real calendar's busy time is otherwise unbounded.
  const slots = freeSlots({ windows: read.windows, busy, now });
  const busyInBookableWindows = intersectIntervals(busy, read.windows);

  const { type, isGuess } = resolveBusinessType(lead.business_type, lead.business_name);
  const zone = leadTimeZone({ state: lead.state, country: lead.country }, active.profile.timezone);
  const view = (slot: Interval): SlotView => ({
    start: slot.start.toISOString(),
    end: slot.end.toISOString(),
    day: formatInTz(slot.start, zone.timeZone, "yyyy-MM-dd"),
    phrase: phraseSlot(slot.start, zone.timeZone, now),
    zone: zoneAbbreviation(slot.start, zone.timeZone),
    yourTime: yourTimeLine(slot.start, zone.timeZone, active.profile.timezone),
  });

  return {
    leadId: lead.id,
    businessName: lead.business_name,
    businessType: type,
    businessTypeIsGuess: isGuess,
    leadTimeZone: zone.timeZone,
    leadTimeZoneIsGuess: zone.isGuess,
    zone: zoneAbbreviation(now, zone.timeZone),
    now: now.toISOString(),
    suggestions: suggestSlots(slots, type, zone.timeZone).map(view),
    slots: slots.map(view),
    busy: busyInBookableWindows.filter((block) => block.end > now).map((block) => ({ start: block.start.toISOString(), end: block.end.toISOString() })),
    mine: await myMeetings(active, now),
  };
}

// ---------------------------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------------------------

const MAX_NOTE_LENGTH = 500;
/** Booking never moves a lead backwards or out of Do Not Contact (compare NO_DOWNGRADE_STATUSES in outcomes.ts). */
const KEEP_STATUS_ON_BOOKING: readonly LeadStatus[] = ["APPOINTMENT", "PROPOSAL", "CLIENT", "DO_NOT_CONTACT"];

export interface BookedAppointment {
  id: string;
  leadId: string;
  start: string;
  end: string;
  phrase: string;
  zone: string;
  /** True when a booking outside a call could not move the lead to Appointment. */
  statusNeedsAttention: boolean;
}

export interface LeadMeeting {
  id: string;
  start: string;
  end: string;
  /** Admins only; null for agents. */
  bookedByName: string | null;
  /** Whether the viewer booked it, so the page knows to offer Cancel (D48: an agent cancels their own). */
  bookedByMe: boolean;
}

const bookSchema = z.object({
  leadId: z.string(),
  start: z.iso.datetime({ offset: true, message: "Pick a time from the calendar." }),
  note: z
    .string()
    .trim()
    .max(MAX_NOTE_LENGTH, `A note for the closer can be at most ${MAX_NOTE_LENGTH} characters.`)
    .nullish(),
  clientRequestId: z.uuid(),
  inCall: z.boolean(),
});

/**
 * Runs only on a path that is already failing, so the original error stays the one the agent sees. A failure here
 * is logged (ids and code only) and is harmless: begin_appointment clears a pending row once it is ten minutes old.
 */
async function abandon(ctx: RequestContext, appointmentId: string): Promise<void> {
  const { error } = await ctx.supabase.rpc("abandon_appointment", { p_id: appointmentId });
  if (error) console.error("[booking] abandon_appointment failed", { appointmentId, code: error.code });
}

async function ensureStillFree(ctx: RequestContext, calendar: CalendarClient, appointmentId: string, start: Date, now: Date): Promise<void> {
  let read: { windows: Interval[]; busy: Interval[] };
  try {
    // Never cached, so the owner here only completes the key; the re-check must always hit the calendar.
    read = await readCalendar(calendar, ctx.userId, new Date(start.getTime() - SLOT_MS), new Date(start.getTime() + 2 * SLOT_MS), false);
  } catch (error) {
    await abandon(ctx, appointmentId);
    throw error;
  }
  const free = freeSlots({ windows: read.windows, busy: read.busy, now }).some((slot) => slot.start.getTime() === start.getTime());
  if (!free) {
    await abandon(ctx, appointmentId);
    throw new AppError("conflict", SLOT_TAKEN_MESSAGE, { reason: "slot_taken" });
  }
}

function appBaseUrl(): string | null {
  try {
    return getServerEnv().APP_BASE_URL ?? null;
  } catch {
    return null;
  }
}

async function createMeetingEvent(
  ctx: RequestContext,
  calendar: CalendarClient,
  appointmentId: string,
  leadId: string,
  start: Date,
  end: Date,
  note: string | null,
  clientRequestId: string,
): Promise<string> {
  const { data: lead, error } = await ctx.supabase
    .from("leads")
    .select("business_name, contact_name, phone, city, state, email")
    .eq("id", leadId)
    .maybeSingle();
  if (error || !lead) {
    await abandon(ctx, appointmentId);
    if (error) fail(error);
    throw new AppError("not_found");
  }
  const baseUrl = appBaseUrl();
  try {
    // A variable, not an inline literal: `leadEmail` and `clientRequestId` are carried by GoogleCalendarClient's
    // wider input type (src/server/calendar/google.ts) but not by the CalendarClient interface `calendar` is
    // statically typed as, so an inline object literal would trip TypeScript's excess-property check. The mock
    // calendar simply ignores the extra fields.
    const input = {
      start,
      end,
      title: meetingTitle(lead.business_name),
      description: buildMeetingDescription({
        businessName: lead.business_name,
        contactName: lead.contact_name,
        phone: lead.phone,
        city: lead.city,
        state: lead.state,
        bookedBy: ctx.profile.name || ctx.profile.email,
        note,
        leadUrl: baseUrl ? `${baseUrl}/leads/${leadId}` : null,
      }),
      leadEmail: lead.email,
      agentEmail: ctx.profile.email,
      clientRequestId,
    };
    const { eventId } = await calendar.createMeeting(input);
    return eventId;
  } catch (cause) {
    console.error("[booking] createMeeting failed", { appointmentId, code: cause instanceof Error ? cause.name : typeof cause });
    await abandon(ctx, appointmentId);
    if (cause instanceof GoogleApiError && cause.kind === "invalid_grant") {
      throw new AppError("unavailable", BOOKING_UNAVAILABLE_MESSAGE, { cause });
    }
    throw new AppError("unavailable", BOOKING_FAILED_MESSAGE, { cause });
  }
}

/** True when the lead's status is where a booking leaves it; false tells the agent to set Appointment by hand. */
async function moveToAppointment(ctx: RequestContext, leadId: string): Promise<boolean> {
  const { data, error } = await ctx.supabase.from("leads").select("status").eq("id", leadId).maybeSingle();
  if (error || !data) return false;
  if (KEEP_STATUS_ON_BOOKING.includes(data.status)) return true;
  try {
    await updateLeadStatus(ctx, leadId, "APPOINTMENT");
    return true;
  } catch {
    // Not swallowed: the booking stands, and the result tells the agent to set the status by hand.
    return false;
  }
}

async function bookedView(
  ctx: RequestContext,
  id: string,
  leadId: string,
  start: Date,
  end: Date,
  now: Date,
): Promise<Omit<BookedAppointment, "statusNeedsAttention">> {
  const { data: lead } = await ctx.supabase.from("leads").select("state, country").eq("id", leadId).maybeSingle();
  const { timeZone } = leadTimeZone({ state: lead?.state ?? null, country: lead?.country ?? null }, ctx.profile.timezone);
  return {
    id,
    leadId,
    start: start.toISOString(),
    end: end.toISOString(),
    phrase: phraseSlot(start, timeZone, now),
    zone: zoneAbbreviation(start, timeZone),
  };
}

/**
 * begin_appointment (access, rate limit, replay, one live booking per slot) → re-check the calendar without the
 * cache → create the event → confirm_appointment. Failures abandon the pending appointment until the meeting event
 * is created (docs/DEVIATIONS.md D46); a confirm_appointment failure after that point does not abandon it, since
 * the calendar event already exists.
 */
export async function bookAppointment(ctx: RequestContext | null, input: unknown, deps: CalendarDeps = {}): Promise<BookedAppointment> {
  const active = requireActive(ctx);
  const parsed = bookSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0]?.message ?? "Pick a time and try again.");
  const leadId = parseId(parsed.data.leadId);
  const note = parsed.data.note ? parsed.data.note : null;
  const calendar = await calendarFor(active, active.userId, deps);
  const now = deps.now?.() ?? new Date();

  const { data: row, error } = await active.supabase.rpc("begin_appointment", {
    p_lead_id: leadId,
    p_starts_at: new Date(parsed.data.start).toISOString(),
    p_note: note ?? undefined,
    p_client_request_id: parsed.data.clientRequestId,
  });
  if (error) fail(error);
  if (!row) throw new AppError("internal");

  const start = new Date(row.starts_at);
  const end = new Date(row.ends_at);
  let statusNeedsAttention = false;
  if (row.status === "pending") {
    await ensureStillFree(active, calendar, row.id, start, now);
    const eventId = await createMeetingEvent(active, calendar, row.id, row.lead_id, start, end, note, parsed.data.clientRequestId);
    const { error: confirmError } = await active.supabase.rpc("confirm_appointment", { p_id: row.id, p_google_event_id: eventId });
    if (confirmError) {
      console.error("[booking] confirm_appointment failed", { appointmentId: row.id, eventId, code: confirmError.code });
      // The Google event already exists but no CRM row references it any more: delete it best effort so a
      // failed booking does not leave an orphan meeting on the closer's calendar (fix round 1). The agent still
      // sees confirmError's ordinary mapped message below — this cleanup never changes what they're told.
      if (isGoogleDriver()) await cancelGoogleEvent(active, active.userId, row.id, eventId);
      fail(confirmError);
    }
    if (!parsed.data.inCall) statusNeedsAttention = !(await moveToAppointment(active, row.lead_id));
  }
  return { ...(await bookedView(active, row.id, row.lead_id, start, end, now)), statusNeedsAttention };
}

/**
 * Deletes a Google event best effort — used both when an appointment is cancelled in the CRM (design §7) and
 * when `confirm_appointment` fails after the event already exists, so neither path leaves an orphan meeting on
 * the closer's calendar. Genuinely never throws: resolving the closer's time zone, loading the connection and
 * hours, and the delete itself all run inside one try, so a database error reading either of those (not just a
 * Google failure) is caught here too (fix round 2) — by the time this runs the CRM side is already settled (the
 * appointment row is either cancelled or about to fail regardless), and the caller's own result or mapped error
 * must not be replaced by an unrelated failure from this best-effort cleanup.
 */
async function cancelGoogleEvent(ctx: RequestContext, ownerId: string, appointmentId: string, eventId: string): Promise<void> {
  try {
    const timeZone = await closerTimeZone(ctx);
    // `ownerId`, not the caller: an admin cancelling an agent's meeting must delete it from that agent's
    // calendar, and the event id means nothing on anyone else's (D48).
    const deps = await buildGoogleDeps(ctx, timeZone, ownerId);
    if (!deps) {
      // No connection, one already marked broken, or an agent with no calendar: the Google event survives and
      // nothing else will ever log it, so this is the one place that can point the admin at the RUNBOOK's
      // manual-reconciliation step.
      console.error("[booking] cancelMeeting skipped", { appointmentId, eventId, ownerId, reason: "no_calendar" });
      return;
    }
    await createGoogleCalendar(deps).cancelMeeting(eventId);
  } catch (error) {
    console.error("[booking] cancelMeeting failed", {
      appointmentId,
      eventId,
      code: error instanceof GoogleApiError ? error.reason : error instanceof Error ? error.name : typeof error,
    });
  }
}

/**
 * An agent cancels their own meeting, an admin cancels any (D48) — the RPC is the guard, and RLS decides which
 * row the follow-up read can see, so an agent can never reach another agent's event id through this.
 */
export async function cancelAppointment(ctx: RequestContext | null, id: unknown): Promise<{ id: string }> {
  const active = requireActive(ctx);
  const appointmentId = parseId(id);
  const { error } = await active.supabase.rpc("cancel_appointment", { p_id: appointmentId });
  if (error) fail(error);

  if (isGoogleDriver()) {
    const { data: row } = await active.supabase
      .from("appointments")
      .select("google_event_id, booked_by")
      .eq("id", appointmentId)
      .maybeSingle();
    if (row?.google_event_id) await cancelGoogleEvent(active, row.booked_by, appointmentId, row.google_event_id);
  }
  return { id: appointmentId };
}

export async function setLeadBusinessType(
  ctx: RequestContext | null,
  leadId: unknown,
  type: unknown,
): Promise<{ leadId: string; businessType: BusinessType | null }> {
  const active = requireActive(ctx);
  const id = parseId(leadId);
  const businessType: BusinessType | null = isBusinessType(type) ? type : null;
  if (type !== null && businessType === null) throw new AppError("validation", "Choose a business type.");
  const { error } = await active.supabase.rpc("set_lead_business_type", { p_lead_id: id, p_type: businessType ?? undefined });
  if (error) fail(error);
  return { leadId: id, businessType };
}

export async function getNextMeeting(ctx: RequestContext | null, leadId: unknown, now: Date = new Date()): Promise<LeadMeeting | null> {
  const active = requireActive(ctx);
  const id = parseId(leadId);
  const { data, error } = await active.supabase
    .from("appointments")
    .select("id, starts_at, ends_at, booked_by")
    .eq("lead_id", id)
    .eq("status", "scheduled")
    .gt("ends_at", now.toISOString())
    .order("starts_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) fail(error);
  if (!data) return null;

  let bookedByName: string | null = null;
  if (active.profile.role === "ADMIN") {
    const { data: profile } = await active.supabase.from("profiles").select("name, email").eq("id", data.booked_by).maybeSingle();
    bookedByName = profile ? profile.name || profile.email : null;
  }
  return {
    id: data.id,
    start: new Date(data.starts_at).toISOString(),
    end: new Date(data.ends_at).toISOString(),
    bookedByName,
    bookedByMe: data.booked_by === active.userId,
  };
}

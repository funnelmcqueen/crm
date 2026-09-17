// Closer calendar booking (docs/DEVIATIONS.md D46). Every query runs with the caller's session: appointments are read
// under RLS and written only through the guarded RPCs in 20260915001900_calendar_booking.sql.
//
// Privacy boundary: nothing from a calendar reaches the browser except start and end times. Intervals are rebuilt
// field by field below, so a client that hands back more (a title, attendees) still cannot leak it.
import { z } from "zod";
import { suggestSlots } from "@/lib/domain/business-rhythm";
import {
  BOOKING_FAILED_MESSAGE,
  BOOKING_UNAVAILABLE_MESSAGE,
  CALENDAR_LOAD_FAILED_MESSAGE,
  SLOT_TAKEN_MESSAGE,
} from "@/lib/domain/booking-messages";
import { isBusinessType, resolveBusinessType, type BusinessType } from "@/lib/domain/business-type";
import { BOOKING_HORIZON_DAYS, SLOT_MS, freeSlots, mergeIntervals, type Interval } from "@/lib/domain/calendar-slots";
import { leadTimeZone } from "@/lib/domain/lead-timezone";
import { buildMeetingDescription, meetingTitle } from "@/lib/domain/meeting-description";
import { phraseSlot, yourTimeLine, zoneAbbreviation } from "@/lib/domain/slot-phrase";
import type { LeadStatus } from "@/lib/domain/statuses";
import { formatInTz } from "@/lib/domain/time";
import { resolveCalendarClient } from "@/server/calendar/client";
import type { CalendarClient } from "@/server/calendar/types";
import { requireActive, requireAdmin, type RequestContext } from "@/server/context";
import { getServerEnv } from "@/server/env";
import { AppError, mapPostgrestError, type PostgrestLikeError } from "@/server/errors";
import { updateLeadStatus } from "@/server/services/leads";

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

async function defaultCalendar(ctx: RequestContext): Promise<CalendarClient | null> {
  const { data } = await ctx.supabase.from("settings").select("default_timezone").limit(1).maybeSingle();
  return resolveCalendarClient(data?.default_timezone ?? "America/New_York");
}

export async function calendarFor(ctx: RequestContext, deps: CalendarDeps): Promise<CalendarClient> {
  const calendar = deps.calendar !== undefined ? deps.calendar : await defaultCalendar(ctx);
  if (!calendar) throw new AppError("unavailable", BOOKING_UNAVAILABLE_MESSAGE);
  return calendar;
}

// Best effort and per server instance: correctness comes from the re-check when booking.
let cache: { key: string; expires: number; windows: Interval[]; busy: Interval[] } | null = null;

export async function readCalendar(
  calendar: CalendarClient,
  from: Date,
  to: Date,
  useCache: boolean,
): Promise<{ windows: Interval[]; busy: Interval[] }> {
  const key = `${from.toISOString()}|${to.toISOString()}`;
  if (useCache && cache && cache.key === key && cache.expires > Date.now()) {
    return { windows: cache.windows, busy: cache.busy };
  }
  let read: Awaited<ReturnType<CalendarClient["readAvailability"]>>;
  try {
    read = await calendar.readAvailability({ from, to });
  } catch (error) {
    console.error("[booking] readAvailability failed", { code: error instanceof Error ? error.name : typeof error });
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

  const calendar = await calendarFor(active, deps);
  const now = deps.now?.() ?? new Date();
  // Whole-hour range: requests within the same hour share one cache entry.
  const from = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const to = new Date(from.getTime() + (BOOKING_HORIZON_DAYS + 1) * DAY_MS);
  const read = await readCalendar(calendar, from, to, deps.calendar === undefined);

  const { data: booked, error: bookedError } = await active.supabase.rpc("booked_intervals", {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (bookedError) fail(bookedError);

  const busy = mergeIntervals([
    ...read.busy,
    ...(booked ?? []).map((row) => ({ start: new Date(row.starts_at), end: new Date(row.ends_at) })),
  ]);
  const slots = freeSlots({ windows: read.windows, busy, now });

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
    busy: busy.filter((block) => block.end > now).map((block) => ({ start: block.start.toISOString(), end: block.end.toISOString() })),
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
    read = await readCalendar(calendar, new Date(start.getTime() - SLOT_MS), new Date(start.getTime() + 2 * SLOT_MS), false);
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
): Promise<string> {
  const { data: lead, error } = await ctx.supabase
    .from("leads")
    .select("business_name, contact_name, phone, city, state")
    .eq("id", leadId)
    .maybeSingle();
  if (error || !lead) {
    await abandon(ctx, appointmentId);
    if (error) fail(error);
    throw new AppError("not_found");
  }
  const baseUrl = appBaseUrl();
  try {
    const { eventId } = await calendar.createMeeting({
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
    });
    return eventId;
  } catch (cause) {
    console.error("[booking] createMeeting failed", { appointmentId, code: cause instanceof Error ? cause.name : typeof cause });
    await abandon(ctx, appointmentId);
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
  const calendar = await calendarFor(active, deps);
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
    const eventId = await createMeetingEvent(active, calendar, row.id, row.lead_id, start, end, note);
    const { error: confirmError } = await active.supabase.rpc("confirm_appointment", { p_id: row.id, p_google_event_id: eventId });
    if (confirmError) {
      console.error("[booking] confirm_appointment failed", { appointmentId: row.id, eventId, code: confirmError.code });
      fail(confirmError);
    }
    if (!parsed.data.inCall) statusNeedsAttention = !(await moveToAppointment(active, row.lead_id));
  }
  return { ...(await bookedView(active, row.id, row.lead_id, start, end, now)), statusNeedsAttention };
}

export async function cancelAppointment(ctx: RequestContext | null, id: unknown): Promise<{ id: string }> {
  const admin = requireAdmin(ctx);
  const appointmentId = parseId(id);
  const { error } = await admin.supabase.rpc("cancel_appointment", { p_id: appointmentId });
  if (error) fail(error);
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
  return { id: data.id, start: new Date(data.starts_at).toISOString(), end: new Date(data.ends_at).toISOString(), bookedByName };
}

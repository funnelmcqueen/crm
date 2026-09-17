// Closer calendar booking (docs/DEVIATIONS.md D46). Every query runs with the caller's session: appointments are read
// under RLS and written only through the guarded RPCs in 20260915001900_calendar_booking.sql.
//
// Privacy boundary: nothing from a calendar reaches the browser except start and end times. Intervals are rebuilt
// field by field below, so a client that hands back more (a title, attendees) still cannot leak it.
import { z } from "zod";
import { suggestSlots } from "@/lib/domain/business-rhythm";
import { BOOKING_UNAVAILABLE_MESSAGE, CALENDAR_LOAD_FAILED_MESSAGE } from "@/lib/domain/booking-messages";
import { resolveBusinessType, type BusinessType } from "@/lib/domain/business-type";
import { BOOKING_HORIZON_DAYS, freeSlots, mergeIntervals, type Interval } from "@/lib/domain/calendar-slots";
import { leadTimeZone } from "@/lib/domain/lead-timezone";
import { phraseSlot, yourTimeLine, zoneAbbreviation } from "@/lib/domain/slot-phrase";
import { formatInTz } from "@/lib/domain/time";
import { resolveCalendarClient } from "@/server/calendar/client";
import type { CalendarClient } from "@/server/calendar/types";
import { requireActive, type RequestContext } from "@/server/context";
import { AppError, mapPostgrestError, type PostgrestLikeError } from "@/server/errors";

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

export function clearAvailabilityCacheForTests(): void {
  cache = null;
}

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

// Turns the CRM's bookable hours (docs/DEVIATIONS.md D47) into the calendar windows the slot engine
// consumes (calendar-slots.ts). Pure; no I/O. Hours are minutes from local midnight in a given time zone,
// half-open per weekday (0 = Sunday .. 6 = Saturday), the same convention `bookable_hours` enforces in
// Postgres.

import { TZDate } from "@date-fns/tz";
import type { Interval } from "./calendar-slots";
import { endOfDayInTz, startOfDayInTz, zonedLocalInputToUtc } from "./time";

export const HOURS_GRANULARITY_MINUTES = 30;
const MINUTES_PER_DAY = 24 * 60;

export interface BookableRange {
  weekday: number;
  startsMinute: number;
  endsMinute: number;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * UTC instant of `minute` minutes past local midnight, on the local day that starts at `dayStart` and
 * ends at `nextDayStart` (from `startOfDayInTz`/`endOfDayInTz`). Built from the day's wall-clock fields
 * via `zonedLocalInputToUtc`, the same way `time.ts` builds every other zoned instant, so a DST
 * transition elsewhere in the day does not shift it: adding `minute * 60_000` milliseconds to `dayStart`
 * would get this wrong on a day whose length is 23 or 25 hours.
 */
function instantAtMinute(dayStart: Date, nextDayStart: Date, minute: number, timeZone: string): Date {
  if (minute <= 0) return dayStart;
  if (minute >= MINUTES_PER_DAY) return nextDayStart;
  const zoned = new TZDate(dayStart.getTime(), timeZone);
  const local = `${zoned.getFullYear()}-${pad(zoned.getMonth() + 1)}-${pad(zoned.getDate())}T${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
  return zonedLocalInputToUtc(local, timeZone);
}

/**
 * Every range in `ranges` materialised as an `Interval` for each local day the half-open `[from, to)`
 * span touches, clipped to `[from, to)`, sorted by start, with empty results (clipped away entirely)
 * skipped. Windows are not merged; the slot engine merges busy time, not bookable windows.
 */
export function bookableWindows(
  ranges: readonly BookableRange[],
  timeZone: string,
  from: Date,
  to: Date,
): Interval[] {
  const windows: Interval[] = [];
  let dayStart = startOfDayInTz(timeZone, from);
  while (dayStart.getTime() < to.getTime()) {
    const nextDayStart = endOfDayInTz(timeZone, dayStart);
    const weekday = new TZDate(dayStart.getTime(), timeZone).getDay();
    for (const range of ranges) {
      if (range.weekday !== weekday) continue;
      const start = instantAtMinute(dayStart, nextDayStart, range.startsMinute, timeZone);
      const end = instantAtMinute(dayStart, nextDayStart, range.endsMinute, timeZone);
      const clippedStart = Math.max(start.getTime(), from.getTime());
      const clippedEnd = Math.min(end.getTime(), to.getTime());
      if (clippedEnd > clippedStart) {
        windows.push({ start: new Date(clippedStart), end: new Date(clippedEnd) });
      }
    }
    dayStart = nextDayStart;
  }
  return windows.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * The same rules `set_bookable_hours` enforces in Postgres, checked in this order across every range —
 * weekday, granularity, ordering, bounds, overlap — returning the first failure's message, or `null` when
 * every range is valid. Weekday comes first: a bad weekday makes every other message about that range
 * meaningless.
 */
export function validateBookableRanges(ranges: readonly BookableRange[]): string | null {
  for (const range of ranges) {
    if (range.weekday < 0 || range.weekday > 6) {
      return "Pick a day of the week.";
    }
  }
  for (const range of ranges) {
    if (range.startsMinute % HOURS_GRANULARITY_MINUTES !== 0 || range.endsMinute % HOURS_GRANULARITY_MINUTES !== 0) {
      return "Times must be on the hour or the half hour.";
    }
  }
  for (const range of ranges) {
    if (range.startsMinute >= range.endsMinute) {
      return "A start time must come before its end time.";
    }
  }
  for (const range of ranges) {
    if (range.startsMinute < 0 || range.endsMinute > MINUTES_PER_DAY) {
      return "Times must be between 00:00 and 24:00.";
    }
  }
  for (let i = 0; i < ranges.length; i += 1) {
    for (let j = i + 1; j < ranges.length; j += 1) {
      const a = ranges[i];
      const b = ranges[j];
      if (a.weekday === b.weekday && a.startsMinute < b.endsMinute && b.startsMinute < a.endsMinute) {
        return "Two ranges on the same day overlap.";
      }
    }
  }
  return null;
}

/** `minute` (0-1440) as a wall-clock string, e.g. `formatMinutes(870) === "14:30"`, `formatMinutes(1440) === "24:00"`. */
export function formatMinutes(minute: number): string {
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

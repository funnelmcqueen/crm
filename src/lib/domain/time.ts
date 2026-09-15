import { TZDate, tzOffset } from '@date-fns/tz';
import { format } from 'date-fns';

export type DateInput = Date | number | string;

export interface FollowUpQuickPicks {
  tomorrow9am: Date;
  in3Days: Date;
  nextWeek: Date;
}

const DAY_MS = 86_400_000;
// IANA names: every segment starts with an uppercase letter. Rejects offsets ("+05:00") and
// wrong-case names ("utc") that Intl accepts but `pg_timezone_names` does not contain.
const IANA_SEGMENT = /^[A-Z][A-Za-z0-9_+-]*$/;
const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  if (!tz.split('/').every((segment) => IANA_SEGMENT.test(segment))) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions();
    return true;
  } catch {
    return false;
  }
}

function assertTimeZone(tz: string): void {
  if (!isValidTimeZone(tz)) throw new RangeError('Invalid time zone');
}

function toTimestamp(input: DateInput): number {
  const time = input instanceof Date ? input.getTime() : typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(time)) throw new RangeError('Invalid date');
  return time;
}

function offsetMs(tz: string, time: number): number {
  return Math.round(tzOffset(tz, new Date(time)) * 60_000);
}

function zonedCalendarDay(time: number, tz: string): { year: number; month: number; day: number } {
  // TZDate getters read UTC fields of an offset-shifted copy, so they do not depend on the host zone.
  const zoned = new TZDate(time, tz);
  return { year: zoned.getFullYear(), month: zoned.getMonth(), day: zoned.getDate() };
}

/**
 * UTC instant of a wall-clock time in `tz`. Overflowing fields roll over like `Date.UTC`. A time
 * inside a DST gap moves forward by the gap (02:30 -> 03:30); an ambiguous time resolves to its
 * first occurrence. Computed from Intl offsets only: TZDate's wall-time constructor resolves
 * ambiguous times differently depending on the host time zone.
 */
function zonedWallTime(
  tz: string,
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0,
  seconds = 0,
): Date {
  const wall = Date.UTC(year, month, day, hours, minutes, seconds);
  // UTC offsets are under 24h, so offsets one day either side bracket any transition at this wall time.
  const offsetBefore = offsetMs(tz, wall - DAY_MS);
  const offsetAfter = offsetMs(tz, wall + DAY_MS);
  const matches = [wall - offsetBefore, wall - offsetAfter].filter((time) => time + offsetMs(tz, time) === wall);
  if (matches.length > 0) return new Date(Math.min(...matches));
  return new Date(wall - offsetBefore);
}

/** Midnight at the start of the calendar day containing `ref` in `tz`. */
export function startOfDayInTz(tz: string, ref: DateInput = new Date()): Date {
  assertTimeZone(tz);
  const { year, month, day } = zonedCalendarDay(toTimestamp(ref), tz);
  return zonedWallTime(tz, year, month, day);
}

/** Exclusive end of that day: the next local midnight (23 or 25 hours later on DST days). */
export function endOfDayInTz(tz: string, ref: DateInput = new Date()): Date {
  assertTimeZone(tz);
  const { year, month, day } = zonedCalendarDay(toTimestamp(ref), tz);
  return zonedWallTime(tz, year, month, day + 1);
}

/** Reschedule shortcuts, all at 09:00 local time in `tz`. */
export function followUpQuickPicks(tz: string, now: DateInput = new Date()): FollowUpQuickPicks {
  assertTimeZone(tz);
  const { year, month, day } = zonedCalendarDay(toTimestamp(now), tz);
  return {
    tomorrow9am: zonedWallTime(tz, year, month, day + 1, 9),
    in3Days: zonedWallTime(tz, year, month, day + 3, 9),
    nextWeek: zonedWallTime(tz, year, month, day + 7, 9),
  };
}

/** Like `zonedLocalInputToUtc`, but returns null for malformed input or an invalid time zone. */
export function tryZonedLocalInputToUtc(value: string | null | undefined, tz: string): Date | null {
  if (typeof value !== 'string' || !isValidTimeZone(tz)) return null;
  const match = LOCAL_INPUT.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = match[6] === undefined ? 0 : Number(match[6]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return zonedWallTime(tz, year, month - 1, day, hours, minutes, seconds);
}

/**
 * Converts an `<input type="datetime-local">` value (`yyyy-MM-ddTHH:mm`, optional `:ss`) entered in
 * `tz` to a UTC instant. Throws RangeError on malformed input or an invalid time zone.
 */
export function zonedLocalInputToUtc(value: string, tz: string): Date {
  assertTimeZone(tz);
  const result = tryZonedLocalInputToUtc(value, tz);
  if (!result) throw new RangeError('Invalid local date-time, expected yyyy-MM-ddTHH:mm');
  return result;
}

/** UTC instant -> `yyyy-MM-ddTHH:mm` wall-clock value in `tz`, for datetime-local inputs. */
export function utcToZonedLocalInput(date: DateInput, tz: string): string {
  return formatInTz(date, tz, "yyyy-MM-dd'T'HH:mm");
}

/** date-fns `format` evaluated in `tz` (independent of the machine's time zone). */
export function formatInTz(date: DateInput, tz: string, pattern: string): string {
  assertTimeZone(tz);
  return format(new TZDate(toTimestamp(date), tz), pattern);
}

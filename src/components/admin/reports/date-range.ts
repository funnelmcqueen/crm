// Report date ranges: inclusive local calendar dates (yyyy-MM-dd) in the admin's timezone, kept in the URL
// as ?from=&to=. Pure and isomorphic, so the page, the picker and the service agree on every boundary.
import { formatInTz, isValidTimeZone, tryZonedLocalInputToUtc, type DateInput } from "@/lib/domain/time";

export const REPORT_PRESETS = ["today", "yesterday", "last7", "last30", "thisMonth"] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

export const REPORT_PRESET_LABELS: Readonly<Record<ReportPreset, string>> = {
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 days",
  last30: "Last 30 days",
  thisMonth: "This month",
};

export const DEFAULT_REPORT_PRESET: ReportPreset = "last7";
/** Inclusive local days. The SQL functions accept the matching instant span (plus one hour for DST). */
export const MAX_REPORT_DAYS = 366;
export const REPORTS_PATH = "/admin/reports";

const FALLBACK_TZ = "America/New_York";
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Inclusive range of local calendar dates. */
export interface LocalDateRange {
  from: string;
  to: string;
}

export type RangeProblem = "invalid_date" | "reversed" | "too_long";

export const RANGE_PROBLEM_MESSAGES: Readonly<Record<RangeProblem, string>> = {
  invalid_date: "Pick a valid start and end date.",
  reversed: "The start date is after the end date.",
  too_long: `Pick a range of ${MAX_REPORT_DAYS} days or less.`,
};

function safeTz(tz: string): string {
  return isValidTimeZone(tz) ? tz : FALLBACK_TZ;
}

function dateParts(value: string): { year: number; month: number; day: number } | null {
  const match = DATE_ONLY.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2999 || month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  return { year, month, day };
}

/** A real calendar date written as yyyy-MM-dd (years 2000-2999). */
export function isLocalDate(value: unknown): value is string {
  return typeof value === "string" && dateParts(value) !== null;
}

function toUtcDay(value: string): number {
  const parts = dateParts(value);
  if (!parts) throw new RangeError("Invalid date, expected yyyy-MM-dd");
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function fromUtcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Calendar arithmetic on a yyyy-MM-dd value (no timezone involved). */
export function addLocalDays(date: string, days: number): string {
  return fromUtcDay(toUtcDay(date) + days * DAY_MS);
}

/** Number of calendar days in the inclusive range (1 for a single day). */
export function localDaySpan(range: LocalDateRange): number {
  return Math.round((toUtcDay(range.to) - toUtcDay(range.from)) / DAY_MS) + 1;
}

/** Today's date in `tz`. */
export function todayInTz(tz: string, now: DateInput = Date.now()): string {
  return formatInTz(now, safeTz(tz), "yyyy-MM-dd");
}

export function presetRange(preset: ReportPreset, tz: string, now: DateInput = Date.now()): LocalDateRange {
  const today = todayInTz(tz, now);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const yesterday = addLocalDays(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case "last7":
      return { from: addLocalDays(today, -6), to: today };
    case "last30":
      return { from: addLocalDays(today, -29), to: today };
    case "thisMonth":
      return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

/** The preset that produces exactly this range today, if any. */
export function matchPreset(range: LocalDateRange, tz: string, now: DateInput = Date.now()): ReportPreset | null {
  for (const preset of REPORT_PRESETS) {
    const candidate = presetRange(preset, tz, now);
    if (candidate.from === range.from && candidate.to === range.to) return preset;
  }
  return null;
}

export function validateLocalRange(from: unknown, to: unknown): RangeProblem | null {
  if (!isLocalDate(from) || !isLocalDate(to)) return "invalid_date";
  if (from > to) return "reversed";
  if (localDaySpan({ from, to }) > MAX_REPORT_DAYS) return "too_long";
  return null;
}

export interface ParsedReportRange {
  range: LocalDateRange;
  /** The matching preset, or null for a custom range. */
  preset: ReportPreset | null;
  /** Set when the URL held an unusable range and the default was used instead. */
  problem: RangeProblem | null;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Reads ?from=&to= (inclusive local dates). Missing params give the default preset; bad ones too, with a problem. */
export function parseReportRangeParams(
  params: Readonly<Record<string, string | string[] | undefined>>,
  tz: string,
  now: DateInput = Date.now(),
): ParsedReportRange {
  const from = first(params.from)?.trim();
  const to = first(params.to)?.trim();
  const fallback = presetRange(DEFAULT_REPORT_PRESET, tz, now);

  if (!from && !to) return { range: fallback, preset: DEFAULT_REPORT_PRESET, problem: null };
  const problem = validateLocalRange(from, to);
  if (problem || !from || !to) {
    return { range: fallback, preset: DEFAULT_REPORT_PRESET, problem: problem ?? "invalid_date" };
  }
  const range = { from, to };
  return { range, preset: matchPreset(range, tz, now), problem: null };
}

/**
 * Half-open UTC instants for the SQL report functions: local midnight starting `from`, and the local
 * midnight after `to`. DST days are 23 or 25 hours long.
 */
export function rangeToInstants(range: LocalDateRange, tz: string): { fromIso: string; toIso: string } {
  const zone = safeTz(tz);
  const start = tryZonedLocalInputToUtc(`${range.from}T00:00`, zone);
  const end = tryZonedLocalInputToUtc(`${addLocalDays(range.to, 1)}T00:00`, zone);
  if (!start || !end) throw new RangeError("Invalid report range");
  return { fromIso: start.toISOString(), toIso: end.toISOString() };
}

export function reportRangeHref(range: LocalDateRange): string {
  return `${REPORTS_PATH}?${new URLSearchParams({ from: range.from, to: range.to }).toString()}`;
}

/** "Mar 8, 2026" or "Mar 8 – Mar 14, 2026" (years shown on both ends when they differ). */
export function formatRangeLabel(range: LocalDateRange): string {
  const label = (date: string, withYear: boolean) =>
    formatInTz(toUtcDay(date) + 12 * 3_600_000, "UTC", withYear ? "MMM d, yyyy" : "MMM d");
  if (range.from === range.to) return label(range.from, true);
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  return `${label(range.from, !sameYear)} – ${label(range.to, true)}`;
}

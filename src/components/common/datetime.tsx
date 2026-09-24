import { formatInTz, isValidTimeZone, type DateInput } from "@/lib/domain/time";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";

export type DateTimeStyle = "date" | "datetime" | "smart";

const FALLBACK_TZ = "America/New_York";

/**
 * Request time for Server Components. Pass it down as `now` so relative labels (overdue, current year)
 * render identically on the server and during hydration.
 */
export function currentTime(): number {
  return Date.now();
}

function safeTz(tz: string): string {
  return isValidTimeZone(tz) ? tz : FALLBACK_TZ;
}

/**
 * Formats an instant in the viewer's time zone. `smart` drops the year for dates in the current year
 * (relative to `now`, which callers pass from the server so server and client render the same text).
 */
export function formatDateTime(
  value: DateInput,
  tz: string,
  style: DateTimeStyle = "smart",
  now: DateInput = Date.now(),
): string {
  const zone = safeTz(tz);
  if (style === "date") return formatInTz(value, zone, "MMM d, yyyy");
  if (style === "datetime") return formatInTz(value, zone, "MMM d, yyyy, h:mm a");
  const sameYear = formatInTz(value, zone, "yyyy") === formatInTz(now, zone, "yyyy");
  return formatInTz(value, zone, sameYear ? "EEE, MMM d, h:mm a" : "MMM d, yyyy, h:mm a");
}

/** Talk time as m:ss (h:mm:ss from one hour). */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

export interface DateTimeProps {
  value: string | null | undefined;
  tz: string;
  style?: DateTimeStyle;
  now?: number;
  /** Shown when there is no value. */
  empty?: string;
  className?: string;
  locale?: Locale;
}

export function DateTime({ value, tz, style = "smart", now, empty = "—", className, locale }: DateTimeProps) {
  if (!value || !Number.isFinite(Date.parse(value))) {
    return <span className={cn("text-muted-foreground", className)}>{empty}</span>;
  }
  return (
    <time dateTime={new Date(value).toISOString()} className={cn("tabular-nums", className)}>
      {locale ? formatDate(new Date(value), locale, {
        ...(style === "date" ? { dateStyle: "medium" as const } : style === "datetime" ? { dateStyle: "medium" as const, timeStyle: "short" as const } : {
          weekday: "short" as const, month: "short" as const, day: "numeric" as const,
          year: formatDate(new Date(value), locale, { year: "numeric", timeZone: safeTz(tz) }) === formatDate(new Date(now ?? value), locale, { year: "numeric", timeZone: safeTz(tz) }) ? undefined : "numeric" as const,
          hour: "numeric" as const, minute: "2-digit" as const,
        }),
        timeZone: safeTz(tz),
      }) : formatDateTime(value, tz, style, now)}
    </time>
  );
}

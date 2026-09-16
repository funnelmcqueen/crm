import { startOfDayInTz, type DateInput } from "@/lib/domain/time";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type DueTone = "overdue" | "today" | "later";

export interface DueDescription {
  tone: DueTone;
  /** Short relative label, e.g. "2 days overdue", "In 45 min", "Tomorrow". */
  label: string;
}

function toTime(input: DateInput): number {
  return input instanceof Date ? input.getTime() : typeof input === "number" ? input : Date.parse(input);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Relative due label in the viewer's time zone. Whole days count local calendar days (so a follow-up due
 * at 17:00 yesterday is "1 day overdue" at 09:00 today); within the same day it counts minutes or hours.
 */
export function describeDue(dueAt: DateInput, now: DateInput, tz: string): DueDescription | null {
  const due = toTime(dueAt);
  const current = toTime(now);
  if (!Number.isFinite(due) || !Number.isFinite(current)) return null;

  const dayDiff = Math.round((startOfDayInTz(tz, due).getTime() - startOfDayInTz(tz, current).getTime()) / DAY);

  if (due < current) {
    const lateDays = -dayDiff;
    if (lateDays >= 1) return { tone: "overdue", label: `${plural(lateDays, "day")} overdue` };
    const minutes = Math.floor((current - due) / MINUTE);
    if (minutes < 1) return { tone: "overdue", label: "Due now" };
    if (minutes < 60) return { tone: "overdue", label: `${minutes} min overdue` };
    return { tone: "overdue", label: `${Math.floor(minutes / 60)}h overdue` };
  }

  if (dayDiff <= 0) {
    const minutes = Math.ceil((due - current) / MINUTE);
    if (minutes < 60) return { tone: "today", label: minutes <= 1 ? "Due now" : `In ${minutes} min` };
    return { tone: "today", label: `In ${Math.floor(minutes / 60)}h` };
  }
  if (dayDiff === 1) return { tone: "later", label: "Tomorrow" };
  return { tone: "later", label: `In ${plural(dayDiff, "day")}` };
}

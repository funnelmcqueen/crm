// A slot phrased the way an agent says it on the call — "Tomorrow at 5 pm" — in the lead's time zone
// (docs/DEVIATIONS.md D46). Pure.
import { TZDate, tzOffset } from "@date-fns/tz";
import { formatInTz } from "./time";

/** Days since the epoch for the calendar date `date` falls on in `timeZone`. */
function calendarDay(date: Date, timeZone: string): number {
  const zoned = new TZDate(date.getTime(), timeZone);
  return Math.floor(Date.UTC(zoned.getFullYear(), zoned.getMonth(), zoned.getDate()) / 86_400_000);
}

/** "5 pm", "4:30 pm", "noon", "midnight". */
export function phraseTime(date: Date, timeZone: string): string {
  const zoned = new TZDate(date.getTime(), timeZone);
  const hours = zoned.getHours();
  const minutes = zoned.getMinutes();
  if (minutes === 0 && hours === 12) return "noon";
  if (minutes === 0 && hours === 0) return "midnight";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const suffix = hours < 12 ? "am" : "pm";
  return minutes === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

/** Today / Tomorrow / weekday within six days / "Mon, Sep 29" beyond, all on the lead's calendar. */
export function phraseSlot(start: Date, timeZone: string, now: Date): string {
  const days = calendarDay(start, timeZone) - calendarDay(now, timeZone);
  const time = phraseTime(start, timeZone);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  if (days >= 2 && days <= 6) return `${formatInTz(start, timeZone, "EEEE")} at ${time}`;
  return `${formatInTz(start, timeZone, "EEE, MMM d")} at ${time}`;
}

/** "EDT", "CST"; zones without a common abbreviation come back as "GMT+1" and similar. */
export function zoneAbbreviation(date: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(date)
    .find((piece) => piece.type === "timeZoneName");
  return part?.value ?? timeZone;
}

/** "(2 pm your time)" when the agent's clock differs from the lead's at that moment, else null. */
export function yourTimeLine(start: Date, leadTimeZone: string, agentTimeZone: string): string | null {
  if (tzOffset(leadTimeZone, start) === tzOffset(agentTimeZone, start)) return null;
  return `(${phraseTime(start, agentTimeZone)} your time)`;
}

// Groups availability into days on the lead's calendar for the booking panel (docs/DEVIATIONS.md D46). Pure.
import { endOfDayInTz, formatInTz, startOfDayInTz } from "@/lib/domain/time";
import type { AgentAvailability, IntervalView, SlotView } from "@/server/services/calendar-booking";

export type BookingEntry =
  | { kind: "slot"; start: string; slot: SlotView }
  | { kind: "busy"; start: string; label: string }
  | { kind: "mine"; start: string; label: string };

export interface BookingDay {
  /** yyyy-MM-dd on the lead's calendar. */
  key: string;
  label: string;
  hasSlots: boolean;
  entries: BookingEntry[];
}

export function buildBookingDays(availability: AgentAvailability, dayCount = 14): BookingDay[] {
  const tz = availability.leadTimeZone;
  const time = (date: Date) => formatInTz(date, tz, "h:mm a");
  const sameAsMine = (block: IntervalView) => availability.mine.some((meeting) => meeting.start === block.start && meeting.end === block.end);

  const days: BookingDay[] = [];
  let dayStart = startOfDayInTz(tz, new Date(availability.now));
  for (let index = 0; index < dayCount; index += 1) {
    const dayEnd = endOfDayInTz(tz, dayStart);
    const key = formatInTz(dayStart, tz, "yyyy-MM-dd");
    const overlapsDay = (view: IntervalView) => new Date(view.start) < dayEnd && new Date(view.end) > dayStart;

    const entries: BookingEntry[] = [
      ...availability.slots.filter((slot) => slot.day === key).map((slot): BookingEntry => ({ kind: "slot", start: slot.start, slot })),
      ...availability.busy
        .filter((block) => overlapsDay(block) && !sameAsMine(block))
        .map((block): BookingEntry => {
          const from = new Date(Math.max(new Date(block.start).getTime(), dayStart.getTime()));
          const to = new Date(Math.min(new Date(block.end).getTime(), dayEnd.getTime()));
          return { kind: "busy", start: from.toISOString(), label: `${time(from)} – ${time(to)}` };
        }),
      ...availability.mine
        .filter(overlapsDay)
        .map((meeting): BookingEntry => ({ kind: "mine", start: meeting.start, label: `${time(new Date(meeting.start))} · ${meeting.businessName}` })),
    ].sort((a, b) => a.start.localeCompare(b.start));

    days.push({ key, label: formatInTz(dayStart, tz, "EEE d"), hasSlots: entries.some((entry) => entry.kind === "slot"), entries });
    dayStart = dayEnd;
  }
  return days;
}

import "server-only";
import { endOfDayInTz, formatInTz, startOfDayInTz, zonedLocalInputToUtc } from "@/lib/domain/time";
import type { CalendarAvailability, CalendarClient, CalendarInterval } from "./types";

// In-memory calendar for development, tests and Playwright (CALENDAR_DRIVER=mock). Refused in production by
// src/server/env.ts. Meetings it creates live for the life of the server process.
//
// One calendar per owner (docs/DEVIATIONS.md D48), matching the Google driver: created meetings are kept per
// owner id, so one agent's booking never shows as busy in another's picker and the same clock time is free for
// each of them. They were a single shared list until D48, when every meeting was the one closer's.

interface MockEvent extends CalendarInterval {
  id: string;
  title: string;
}

const WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ["10:00", "12:00"],
  ["14:00", "17:00"],
];

// Titled on purpose: the privacy tests prove these words never reach an agent.
const SEEDED_BUSY: ReadonlyArray<readonly [string, string, string]> = [
  ["11:00", "11:30", "SECRET: dentist"],
  ["15:00", "16:00", "SECRET: school run"],
];

const createdByOwner = new Map<string, MockEvent[]>();
let sequence = 0;

export function resetMockCalendar(): void {
  createdByOwner.clear();
  sequence = 0;
}

function weekdays(from: Date, to: Date, timeZone: string): string[] {
  const days: string[] = [];
  for (let day = startOfDayInTz(timeZone, from); day < to; day = endOfDayInTz(timeZone, day)) {
    if (Number(formatInTz(day, timeZone, "i")) <= 5) days.push(formatInTz(day, timeZone, "yyyy-MM-dd"));
  }
  return days;
}

function overlaps(interval: CalendarInterval, from: Date, to: Date): boolean {
  return interval.start < to && interval.end > from;
}

/** `ownerId` is whose calendar this is. Every owner gets the same windows and seeded busy, their own meetings. */
export function createMockCalendar(timeZone: string, ownerId: string): CalendarClient {
  const at = (date: string, time: string) => zonedLocalInputToUtc(`${date}T${time}`, timeZone);
  const created = (): MockEvent[] => {
    const existing = createdByOwner.get(ownerId);
    if (existing) return existing;
    const fresh: MockEvent[] = [];
    createdByOwner.set(ownerId, fresh);
    return fresh;
  };

  return {
    async readAvailability({ from, to }): Promise<CalendarAvailability> {
      const days = weekdays(from, to, timeZone);
      const windows = days.flatMap((date) => WINDOWS.map(([start, end]) => ({ start: at(date, start), end: at(date, end) })));
      const seeded: MockEvent[] = days.flatMap((date) =>
        SEEDED_BUSY.map(([start, end, title], index) => ({ id: `mock-busy-${date}-${index}`, title, start: at(date, start), end: at(date, end) })),
      );
      return {
        windows: windows.filter((window) => overlaps(window, from, to)),
        busy: [...seeded, ...created()]
          .filter((event) => overlaps(event, from, to))
          .map((event) => ({ start: event.start, end: event.end })),
      };
    },

    async createMeeting({ start, end, title }) {
      sequence += 1;
      const id = `mock-event-${sequence}`;
      created().push({ id, title, start, end });
      return { eventId: id };
    },
  };
}

// The calendar booking reads and writes (docs/DEVIATIONS.md D46, D47). Implementations: mock.ts
// (CALENDAR_DRIVER=mock) and google.ts (CALENDAR_DRIVER=google).
//
// Contract: readAvailability returns start and end times only. An implementation must never pass through an
// event's title, description or attendees; the availability service rebuilds every interval regardless.

export interface CalendarInterval {
  start: Date;
  end: Date;
}

export interface CalendarAvailability {
  /** Bookable windows, built from `bookable_hours` in the company time zone — not read from a Google calendar (D47). */
  windows: CalendarInterval[];
  /** Busy time on the booking agent's own calendar, overlapping the range (D48). */
  busy: CalendarInterval[];
}

export interface CalendarClient {
  readAvailability(range: { from: Date; to: Date }): Promise<CalendarAvailability>;
  createMeeting(input: { start: Date; end: Date; title: string; description: string }): Promise<{ eventId: string }>;
}

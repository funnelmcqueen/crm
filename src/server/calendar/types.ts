// The calendar booking reads and writes (docs/DEVIATIONS.md D46). Implementations: mock.ts now, Google in Plan 2.
//
// Contract: readAvailability returns start and end times only. An implementation must never pass through an
// event's title, description or attendees; the availability service rebuilds every interval regardless.

export interface CalendarInterval {
  start: Date;
  end: Date;
}

export interface CalendarAvailability {
  /** Bookable windows (events on the closer's bookable-hours calendar) overlapping the range. */
  windows: CalendarInterval[];
  /** Busy time on the closer's main calendar overlapping the range. */
  busy: CalendarInterval[];
}

export interface CalendarClient {
  readAvailability(range: { from: Date; to: Date }): Promise<CalendarAvailability>;
  createMeeting(input: { start: Date; end: Date; title: string; description: string }): Promise<{ eventId: string }>;
}

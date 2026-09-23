// Free 30-minute slots inside the closer's bookable windows (docs/DEVIATIONS.md D46). Pure and instant-based; all
// intervals are half-open [start, end).

export const SLOT_MINUTES = 30;
export const SLOT_MS = SLOT_MINUTES * 60_000;
export const BOOKING_HORIZON_DAYS = 14;
export const BOOKING_NOTICE_MINUTES = 120;

export interface Interval {
  start: Date;
  end: Date;
}

/** Sorted by start, with overlapping or touching intervals joined. Empty or inverted intervals are dropped. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter((interval) => interval.end.getTime() > interval.start.getTime())
    .map((interval) => ({ start: new Date(interval.start), end: new Date(interval.end) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start.getTime() <= last.end.getTime()) {
      if (interval.end.getTime() > last.end.getTime()) last.end = interval.end;
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

/** Every overlap between an interval in a and one in b, clipped to the overlap's own bounds. Order-independent. */
export function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start.getTime(), y.start.getTime());
      const end = Math.min(x.end.getTime(), y.end.getTime());
      if (start < end) result.push({ start: new Date(start), end: new Date(end) });
    }
  }
  return mergeIntervals(result);
}

export interface FreeSlotsInput {
  windows: readonly Interval[];
  busy: readonly Interval[];
  now: Date;
  horizonDays?: number;
  noticeMinutes?: number;
}

/**
 * Every 30-minute slot that lies inside a window, overlaps nothing busy, starts at least the notice period from now
 * and starts before the horizon. Starts are UTC multiples of 30 minutes, which fall on :00/:30 in every time zone
 * whose offset is a whole or half hour — all of the US. `begin_appointment` checks the same boundary.
 */
export function freeSlots(input: FreeSlotsInput): Interval[] {
  const earliest = input.now.getTime() + (input.noticeMinutes ?? BOOKING_NOTICE_MINUTES) * 60_000;
  const latest = input.now.getTime() + (input.horizonDays ?? BOOKING_HORIZON_DAYS) * 86_400_000;
  const busy = mergeIntervals(input.busy);
  const slots: Interval[] = [];
  for (const window of mergeIntervals(input.windows)) {
    const first = Math.ceil(Math.max(window.start.getTime(), earliest) / SLOT_MS) * SLOT_MS;
    for (let start = first; start + SLOT_MS <= window.end.getTime() && start < latest; start += SLOT_MS) {
      const end = start + SLOT_MS;
      if (!busy.some((block) => block.start.getTime() < end && block.end.getTime() > start)) {
        slots.push({ start: new Date(start), end: new Date(end) });
      }
    }
  }
  return slots;
}

// Which open slots suit the lead's day, by business type (docs/DEVIATIONS.md D46). Pure. Hours are minutes of the
// lead's local day, half-open.
import { TZDate } from "@date-fns/tz";
import type { BusinessType } from "./business-type";
import type { Interval } from "./calendar-slots";

type MinuteRange = readonly [number, number];

const at = (hours: number, minutes = 0): number => hours * 60 + minutes;

export interface Rhythm {
  avoid: readonly MinuteRange[];
  best: readonly MinuteRange[];
}

export const RHYTHMS: Readonly<Record<BusinessType, Rhythm>> = {
  restaurant: { avoid: [[at(11), at(14)], [at(17), at(21)]], best: [[at(14, 30), at(16, 30)]] },
  cafe_bakery: { avoid: [[at(6, 30), at(10, 30)], [at(11, 30), at(13, 30)]], best: [[at(14), at(16)]] },
  hotel_motel: { avoid: [[at(7), at(11)], [at(15), at(18)]], best: [[at(11), at(14, 30)]] },
  home_services: { avoid: [[at(8), at(16)]], best: [[at(7), at(8)], [at(16, 30), at(18)]] },
  auto: { avoid: [[at(8), at(10)], [at(16), at(18)]], best: [[at(12, 30), at(15)]] },
  retail: { avoid: [[at(12), at(14)]], best: [[at(9, 30), at(11, 30)]] },
  beauty: { avoid: [[at(10), at(16)]], best: [[at(9), at(10)], [at(16), at(17, 30)]] },
  other: { avoid: [[at(12), at(13)]], best: [[at(10), at(11, 30)], [at(14), at(16)]] },
};

/** Outside these local hours a business meeting is a stretch, whatever the type. */
export const REASONABLE_HOURS: MinuteRange = [at(8), at(19)];
export const SUGGESTION_COUNT = 3;
export const SUGGESTION_SPREAD_MS = 60 * 60_000;

function localMinutes(date: Date, timeZone: string): number {
  const zoned = new TZDate(date.getTime(), timeZone);
  return zoned.getHours() * 60 + zoned.getMinutes();
}

/** +2 entirely inside a best window, -3 overlapping an avoid window, -1 partly outside reasonable hours. */
export function scoreSlot(slot: Interval, type: BusinessType, timeZone: string): number {
  const start = localMinutes(slot.start, timeZone);
  const end = start + Math.round((slot.end.getTime() - slot.start.getTime()) / 60_000);
  const rhythm = RHYTHMS[type];
  let score = 0;
  if (rhythm.best.some(([from, to]) => from <= start && end <= to)) score += 2;
  if (rhythm.avoid.some(([from, to]) => start < to && from < end)) score -= 3;
  if (start < REASONABLE_HOURS[0] || end > REASONABLE_HOURS[1]) score -= 1;
  return score;
}

/** Highest score first, earliest first on ties, and no two picks starting within an hour of each other. */
export function suggestSlots(slots: readonly Interval[], type: BusinessType, timeZone: string): Interval[] {
  const ranked = slots
    .map((slot) => ({ slot, score: scoreSlot(slot, type, timeZone) }))
    .sort((a, b) => b.score - a.score || a.slot.start.getTime() - b.slot.start.getTime());
  const picked: Interval[] = [];
  for (const { slot } of ranked) {
    const farEnough = picked.every((other) => Math.abs(other.start.getTime() - slot.start.getTime()) >= SUGGESTION_SPREAD_MS);
    if (farEnough) picked.push(slot);
    if (picked.length === SUGGESTION_COUNT) break;
  }
  return picked;
}

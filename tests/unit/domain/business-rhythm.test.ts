import { describe, expect, it } from "vitest";
import { scoreSlot, suggestSlots } from "@/lib/domain/business-rhythm";
import type { Interval } from "@/lib/domain/calendar-slots";

const NY = "America/New_York";
/** Tuesday 2026-09-22 in New York (UTC-4): local hh:mm -> a 30-minute slot. */
function local(hhmm: string): Interval {
  const [h, m] = hhmm.split(":").map(Number);
  const start = new Date(Date.UTC(2026, 8, 22, h + 4, m));
  return { start, end: new Date(start.getTime() + 30 * 60_000) };
}

describe("scoreSlot", () => {
  it("rewards a restaurant's quiet afternoon and punishes the rushes", () => {
    expect(scoreSlot(local("14:30"), "restaurant", NY)).toBe(2);
    expect(scoreSlot(local("12:00"), "restaurant", NY)).toBe(-3);
    expect(scoreSlot(local("19:30"), "restaurant", NY)).toBe(-4);
  });

  it("keeps hotels away from check-out and toward midday", () => {
    expect(scoreSlot(local("09:00"), "hotel_motel", NY)).toBe(-3);
    expect(scoreSlot(local("12:00"), "hotel_motel", NY)).toBe(2);
  });

  it("likes contractors before work even though it is early", () => {
    expect(scoreSlot(local("07:00"), "home_services", NY)).toBe(1);
  });

  it("scores in the lead's time zone, not UTC", () => {
    const slot = local("14:30");
    expect(scoreSlot(slot, "restaurant", "America/Los_Angeles")).toBe(-3);
  });
});

describe("suggestSlots", () => {
  const afternoon = ["10:00", "10:30", "14:30", "15:00", "15:30", "16:00", "16:30"].map(local);

  it("picks the best three, at least an hour apart, earliest first on ties", () => {
    const picked = suggestSlots(afternoon, "restaurant", NY).map((slot) => slot.start.toISOString().slice(11, 16));
    expect(picked).toEqual(["18:30", "19:30", "14:00"]);
  });

  it("returns fewer than three when that is all there is", () => {
    expect(suggestSlots([local("14:30"), local("15:00")], "restaurant", NY)).toHaveLength(1);
    expect(suggestSlots([], "other", NY)).toEqual([]);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { createMockCalendar, resetMockCalendar } from "@/server/calendar/mock";

const NY = "America/New_York";
// Monday 2026-09-21 00:00 EDT to Sunday 2026-09-27 00:00 EDT.
const WEEK = { from: new Date("2026-09-21T04:00:00Z"), to: new Date("2026-09-27T04:00:00Z") };

beforeEach(() => resetMockCalendar());

describe("mock calendar", () => {
  it("offers 10-12 and 14-17 on weekdays only, in the closer's zone", async () => {
    const { windows } = await createMockCalendar(NY).readAvailability(WEEK);
    expect(windows).toHaveLength(10);
    expect(windows[0]).toEqual({ start: new Date("2026-09-21T14:00:00Z"), end: new Date("2026-09-21T16:00:00Z") });
    expect(windows[1]).toEqual({ start: new Date("2026-09-21T18:00:00Z"), end: new Date("2026-09-21T21:00:00Z") });
  });

  it("returns busy time as bare start and end, and counts meetings it created", async () => {
    const calendar = createMockCalendar(NY);
    const before = await calendar.readAvailability(WEEK);
    expect(before.busy).toHaveLength(10);
    for (const block of before.busy) expect(Object.keys(block).sort()).toEqual(["end", "start"]);

    const start = new Date("2026-09-22T14:30:00Z");
    const { eventId } = await calendar.createMeeting({ start, end: new Date("2026-09-22T15:00:00Z"), title: "Meeting: Swan Motel", description: "x" });
    expect(eventId).toMatch(/^mock-event-/);
    const after = await createMockCalendar(NY).readAvailability(WEEK);
    expect(after.busy).toHaveLength(11);
    expect(JSON.stringify(after)).not.toContain("SECRET");
    expect(JSON.stringify(after)).not.toContain("Swan Motel");
  });
});

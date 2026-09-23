import { describe, expect, it } from "vitest";
import { buildBookingDays } from "@/components/booking/booking-model";
import type { AgentAvailability } from "@/server/services/calendar-booking";

const base: AgentAvailability = {
  leadId: "lead",
  businessName: "Swan Motel",
  businessType: "hotel_motel",
  businessTypeIsGuess: true,
  leadTimeZone: "America/New_York",
  leadTimeZoneIsGuess: false,
  zone: "EDT",
  now: "2026-09-21T13:00:00.000Z", // Monday 09:00 EDT
  suggestions: [],
  slots: [
    { start: "2026-09-21T15:00:00.000Z", end: "2026-09-21T15:30:00.000Z", day: "2026-09-21", phrase: "Today at 11 am", zone: "EDT", yourTime: null },
    { start: "2026-09-22T14:00:00.000Z", end: "2026-09-22T14:30:00.000Z", day: "2026-09-22", phrase: "Tomorrow at 10 am", zone: "EDT", yourTime: null },
  ],
  busy: [
    { start: "2026-09-22T02:00:00.000Z", end: "2026-09-22T05:00:00.000Z" }, // Mon 22:00 to Tue 01:00 EDT
    { start: "2026-09-21T16:00:00.000Z", end: "2026-09-21T16:30:00.000Z" },
  ],
  mine: [{ id: "m1", leadId: "lead", businessName: "Swan Motel", start: "2026-09-21T16:00:00.000Z", end: "2026-09-21T16:30:00.000Z" }],
};

describe("buildBookingDays", () => {
  it("lays out 14 days on the lead's calendar from today", () => {
    const days = buildBookingDays(base);
    expect(days).toHaveLength(14);
    expect(days[0]).toMatchObject({ key: "2026-09-21", label: "Mon 21", hasSlots: true });
    expect(days[2]).toMatchObject({ key: "2026-09-23", hasSlots: false, entries: [] });
  });

  it("orders slots, busy time and own meetings, showing an own meeting once", () => {
    const [monday] = buildBookingDays(base);
    expect(monday.entries.map((entry) => entry.kind)).toEqual(["slot", "mine", "busy"]);
    expect(monday.entries[1]).toMatchObject({ kind: "mine", label: "12:00 PM · Swan Motel" });
    expect(monday.entries[2]).toMatchObject({ kind: "busy", label: "10:00 PM – 12:00 AM" });
  });

  it("clips busy time that crosses midnight to each day", () => {
    const tuesday = buildBookingDays(base)[1];
    expect(tuesday.entries[0]).toMatchObject({ kind: "busy", label: "12:00 AM – 1:00 AM" });
  });
});

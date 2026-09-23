import { describe, expect, it } from "vitest";
import { phraseSlot, phraseTime, yourTimeLine, zoneAbbreviation } from "@/lib/domain/slot-phrase";

const NY = "America/New_York";
const NOW = new Date("2026-09-17T14:00:00Z"); // Thursday 10:00 EDT

describe("phraseSlot", () => {
  it.each([
    ["2026-09-17T20:30:00Z", "Today at 4:30 pm"],
    ["2026-09-18T21:00:00Z", "Tomorrow at 5 pm"],
    ["2026-09-21T14:00:00Z", "Monday at 10 am"],
    ["2026-09-24T16:00:00Z", "Thu, Sep 24 at noon"],
    ["2026-09-19T04:00:00Z", "Saturday at midnight"],
  ])("%s reads as %s", (iso, phrase) => {
    expect(phraseSlot(new Date(iso), NY, NOW)).toBe(phrase);
  });

  it("counts days on the lead's calendar, not UTC", () => {
    const lateEvening = new Date("2026-09-18T03:30:00Z"); // 23:30 EDT on Sep 17
    expect(phraseSlot(new Date("2026-09-18T13:00:00Z"), NY, lateEvening)).toBe("Tomorrow at 9 am");
  });
});

describe("phraseTime", () => {
  it("drops :00 on the hour and keeps minutes otherwise", () => {
    expect(phraseTime(new Date("2026-09-17T13:00:00Z"), NY)).toBe("9 am");
    expect(phraseTime(new Date("2026-09-17T13:30:00Z"), NY)).toBe("9:30 am");
  });
});

describe("zoneAbbreviation", () => {
  it("names US zones and follows the clock change", () => {
    expect(zoneAbbreviation(new Date("2026-09-17T14:00:00Z"), NY)).toBe("EDT");
    expect(zoneAbbreviation(new Date("2026-09-17T14:00:00Z"), "America/Chicago")).toBe("CDT");
    expect(zoneAbbreviation(new Date("2026-11-02T14:00:00Z"), NY)).toBe("EST");
  });
});

describe("yourTimeLine", () => {
  const five = new Date("2026-09-18T21:00:00Z");

  it("is empty when agent and lead share the offset", () => {
    expect(yourTimeLine(five, NY, "America/Detroit")).toBeNull();
  });

  it("gives the agent's own clock otherwise", () => {
    expect(yourTimeLine(five, NY, "America/Los_Angeles")).toBe("(2 pm your time)");
  });
});

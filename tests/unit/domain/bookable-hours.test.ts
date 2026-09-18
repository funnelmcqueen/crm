import { describe, expect, it } from "vitest";
import { bookableWindows, formatMinutes, validateBookableRanges, type BookableRange } from "@/lib/domain/bookable-hours";

const NY = "America/New_York";
const at = (iso: string) => new Date(iso);

const range = (weekday: number, startsMinute: number, endsMinute: number): BookableRange => ({
  weekday,
  startsMinute,
  endsMinute,
});

describe("bookableWindows", () => {
  it("materialises a Monday-only range at its zoned instant", () => {
    // 2027-01-04 is a Monday, well clear of any DST transition.
    const windows = bookableWindows(
      [range(1, 600, 720)],
      NY,
      at("2027-01-01T00:00:00Z"),
      at("2027-01-08T00:00:00Z"),
    );
    expect(windows).toEqual([{ start: at("2027-01-04T15:00:00.000Z"), end: at("2027-01-04T17:00:00.000Z") }]);
  });

  it("yields two windows on the same weekday in start order", () => {
    const windows = bookableWindows(
      [range(1, 840, 900), range(1, 600, 660)],
      NY,
      at("2027-01-01T00:00:00Z"),
      at("2027-01-08T00:00:00Z"),
    );
    expect(windows).toEqual([
      { start: at("2027-01-04T15:00:00.000Z"), end: at("2027-01-04T16:00:00.000Z") },
      { start: at("2027-01-04T19:00:00.000Z"), end: at("2027-01-04T20:00:00.000Z") },
    ]);
  });

  it("clips a window that from falls inside, and drops one that ends before from", () => {
    const from = at("2027-01-04T16:00:00Z"); // 11:00 EST Monday, inside the 10:00-12:00 window
    const windows = bookableWindows(
      [range(1, 480, 540), range(1, 600, 720)], // 08:00-09:00 (ends before from) and 10:00-12:00
      NY,
      from,
      at("2027-01-05T00:00:00Z"),
    );
    expect(windows).toEqual([{ start: from, end: at("2027-01-04T17:00:00.000Z") }]);
  });

  it("keeps a 10:00 local window at 10:00 local across the spring-forward weekend", () => {
    // US spring-forward 2027: clocks jump at 02:00 EST -> 03:00 EDT on Sunday 2027-03-14.
    const windows = bookableWindows(
      [range(6, 600, 720), range(0, 600, 720)], // Saturday and Sunday, 10:00-12:00
      NY,
      at("2027-03-13T00:00:00Z"),
      at("2027-03-15T00:00:00Z"),
    );
    expect(windows).toEqual([
      { start: at("2027-03-13T15:00:00.000Z"), end: at("2027-03-13T17:00:00.000Z") }, // Saturday, still EST
      { start: at("2027-03-14T14:00:00.000Z"), end: at("2027-03-14T16:00:00.000Z") }, // Sunday, already EDT
    ]);
  });

  it("yields nothing for an empty ranges array", () => {
    const windows = bookableWindows([], NY, at("2027-01-01T00:00:00Z"), at("2027-01-08T00:00:00Z"));
    expect(windows).toEqual([]);
  });
});

describe("validateBookableRanges", () => {
  it("accepts ranges that touch but do not overlap", () => {
    expect(validateBookableRanges([range(1, 540, 660), range(1, 660, 780)])).toBeNull();
  });

  it("rejects a weekday outside 0-6", () => {
    expect(validateBookableRanges([range(7, 600, 720)])).toBe("Pick a day of the week.");
    expect(validateBookableRanges([range(-1, 600, 720)])).toBe("Pick a day of the week.");
  });

  it("rejects a time off the half hour", () => {
    expect(validateBookableRanges([range(1, 545, 600)])).toBe("Times must be on the hour or the half hour.");
  });

  it("rejects a start that is not before its end", () => {
    expect(validateBookableRanges([range(1, 720, 600)])).toBe("A start time must come before its end time.");
  });

  it("rejects an end past 24:00", () => {
    expect(validateBookableRanges([range(1, 600, 1500)])).toBe("Times must be between 00:00 and 24:00.");
  });

  it("rejects two overlapping ranges on the same weekday", () => {
    expect(validateBookableRanges([range(1, 600, 720), range(1, 660, 780)])).toBe("Two ranges on the same day overlap.");
  });
});

describe("formatMinutes", () => {
  it.each([
    [0, "00:00"],
    [870, "14:30"],
    [1440, "24:00"],
  ])("formats %i as %s", (minute, expected) => {
    expect(formatMinutes(minute)).toBe(expected);
  });
});

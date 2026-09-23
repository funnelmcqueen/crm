import { describe, expect, it } from "vitest";
import { freeSlots, mergeIntervals, type Interval } from "@/lib/domain/calendar-slots";

const at = (iso: string) => new Date(iso);
const span = (start: string, end: string): Interval => ({ start: at(start), end: at(end) });
const starts = (slots: Interval[]) => slots.map((slot) => slot.start.toISOString().slice(11, 16));
const NOW = at("2026-09-21T06:00:00Z");

describe("mergeIntervals", () => {
  it("sorts, joins overlapping and touching intervals, and drops empty ones", () => {
    const merged = mergeIntervals([
      span("2026-09-21T11:00:00Z", "2026-09-21T12:00:00Z"),
      span("2026-09-21T10:00:00Z", "2026-09-21T11:00:00Z"),
      span("2026-09-21T11:30:00Z", "2026-09-21T11:45:00Z"),
      span("2026-09-21T14:00:00Z", "2026-09-21T14:00:00Z"),
    ]);
    expect(merged).toEqual([span("2026-09-21T10:00:00Z", "2026-09-21T12:00:00Z")]);
  });
});

describe("freeSlots", () => {
  it("aligns slots to :00 and :30 inside a window", () => {
    const slots = freeSlots({ windows: [span("2026-09-21T12:10:00Z", "2026-09-21T14:00:00Z")], busy: [], now: NOW, noticeMinutes: 0 });
    expect(starts(slots)).toEqual(["12:30", "13:00", "13:30"]);
  });

  it("treats intervals as half-open, so busy until 10:30 still leaves 10:30 free", () => {
    const slots = freeSlots({
      windows: [span("2026-09-21T10:00:00Z", "2026-09-21T11:00:00Z")],
      busy: [span("2026-09-21T10:00:00Z", "2026-09-21T10:30:00Z")],
      now: NOW,
      noticeMinutes: 0,
    });
    expect(starts(slots)).toEqual(["10:30"]);
  });

  it("skips anything overlapping busy time", () => {
    const slots = freeSlots({
      windows: [span("2026-09-21T10:00:00Z", "2026-09-21T12:00:00Z")],
      busy: [span("2026-09-21T10:45:00Z", "2026-09-21T11:15:00Z")],
      now: NOW,
      noticeMinutes: 0,
    });
    expect(starts(slots)).toEqual(["10:00", "11:30"]);
  });

  it("keeps two hours of notice by default", () => {
    const slots = freeSlots({ windows: [span("2026-09-21T09:00:00Z", "2026-09-21T13:00:00Z")], busy: [], now: at("2026-09-21T09:05:00Z") });
    expect(starts(slots)).toEqual(["11:30", "12:00", "12:30"]);
  });

  it("offers nothing starting 14 days or more ahead", () => {
    const slots = freeSlots({ windows: [span("2026-10-05T05:00:00Z", "2026-10-05T07:00:00Z")], busy: [], now: NOW, noticeMinutes: 0 });
    expect(starts(slots)).toEqual(["05:00", "05:30"]);
  });

  it("follows a window across midnight", () => {
    const slots = freeSlots({ windows: [span("2026-09-21T22:00:00Z", "2026-09-22T01:00:00Z")], busy: [], now: NOW, noticeMinutes: 0 });
    expect(slots).toHaveLength(6);
  });

  it("counts real time across a clock change (01:00 EDT to 03:00 EST is three hours)", () => {
    const slots = freeSlots({ windows: [span("2026-11-01T05:00:00Z", "2026-11-01T08:00:00Z")], busy: [], now: at("2026-10-31T00:00:00Z"), noticeMinutes: 0 });
    expect(slots).toHaveLength(6);
  });

  it("returns nothing without windows", () => {
    expect(freeSlots({ windows: [], busy: [], now: NOW })).toEqual([]);
  });
});

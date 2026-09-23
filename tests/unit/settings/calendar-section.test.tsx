import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CalendarSection } from "@/components/settings/calendar-section";
import type { BookableRange } from "@/lib/domain/bookable-hours";
import type { CalendarConnectionStatus } from "@/server/services/calendar-connection";

// The Disconnect and Save hours controls import server actions; rendering markup needs none of the server
// code behind them (same approach as tests/unit/booking/next-meeting.test.tsx).
vi.mock("@/server/actions/calendar-connection", () => ({
  saveBookableHoursAction: vi.fn(),
  disconnectCalendarAction: vi.fn(),
}));

const TIME_ZONE = "America/New_York";
const NO_HOURS: BookableRange[] = [];

const NOT_CONNECTED: CalendarConnectionStatus = { connected: false, googleEmail: null, hoursSet: false, broken: false };
const CONNECTED: CalendarConnectionStatus = { connected: true, googleEmail: "closer@example.com", hoursSet: true, broken: false };
const CONNECTED_NO_HOURS: CalendarConnectionStatus = { connected: true, googleEmail: "closer@example.com", hoursSet: false, broken: false };
const BROKEN: CalendarConnectionStatus = { connected: true, googleEmail: "closer@example.com", hoursSet: true, broken: true };

function render(status: CalendarConnectionStatus, hours: BookableRange[] = NO_HOURS): string {
  return renderToStaticMarkup(createElement(CalendarSection, { status, hours, timeZone: TIME_ZONE }));
}

describe("CalendarSection", () => {
  it("shows Not connected with a Connect link to /api/google/start when there is no connection", () => {
    const html = render(NOT_CONNECTED);
    expect(html).toContain("Not connected");
    expect(html).toMatch(/<a[^>]*href="\/api\/google\/start"[^>]*>Connect Google Calendar<\/a>/);
  });

  it("shows the account email and a Disconnect control when connected, with no token-looking string", () => {
    const html = render(CONNECTED);
    expect(html).toContain("closer@example.com");
    expect(html).toContain("Disconnect");
    expect(html).not.toMatch(/token|ciphertext|ya29\./i);
  });

  // Radix's AlertDialog only renders its Content into markup while `open` is true, so this also proves the
  // confirmation dialog is closed by default: the Disconnect fix (Task 8 review round 1) made `open` an
  // explicit useState(false) instead of leaving Radix's own uncontrolled default, and a regression there
  // (e.g. defaulting to true) would pop the confirmation open on every page load.
  //
  // This does NOT cover the actual bug that was fixed (the dialog failing to close after a successful
  // disconnect): renderToStaticMarkup is a single, non-interactive server render with no event dispatch, no
  // state updates and no effects, so it cannot click a button, resolve the mocked async action, or observe
  // an open-state transition. That behaviour isn't expressible as a test in this file's approach.
  it("keeps the Disconnect confirmation closed by default", () => {
    const html = render(CONNECTED);
    expect(html).not.toContain("Disconnect Google Calendar?");
  });

  it("shows the reconnect banner and still shows the email when the connection is broken", () => {
    const html = render(BROKEN);
    expect(html).toContain("Reconnect");
    expect(html).toContain("closer@example.com");
    expect(html).not.toMatch(/token|ciphertext|ya29\./i);
  });

  it("warns that agents cannot book when no bookable hours are set at all", () => {
    const html = render(CONNECTED_NO_HOURS);
    expect(html).toContain("No bookable hours set, so agents cannot book.");
  });

  it("does not warn when bookable hours are set", () => {
    const html = render(CONNECTED, [{ weekday: 1, startsMinute: 600, endsMinute: 720 }]);
    expect(html).not.toContain("No bookable hours set");
  });

  it("renders each range under its weekday name, and Closed for a weekday with none", () => {
    const hours: BookableRange[] = [{ weekday: 1, startsMinute: 600, endsMinute: 720 }];
    const html = render(CONNECTED, hours);
    expect(html).toContain("Monday");
    expect(html).toContain("10:00 – 12:00");
    expect(html.indexOf("Monday")).toBeLessThan(html.indexOf("10:00 – 12:00"));
    expect(html).toContain("Sunday");
    expect(html).toContain("Closed");
  });
});

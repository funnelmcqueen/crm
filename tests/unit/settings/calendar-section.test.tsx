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

  it("shows the reconnect banner and still shows the email when the connection is broken", () => {
    const html = render(BROKEN);
    expect(html).toContain("Reconnect");
    expect(html).toContain("closer@example.com");
    expect(html).not.toMatch(/token|ciphertext|ya29\./i);
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

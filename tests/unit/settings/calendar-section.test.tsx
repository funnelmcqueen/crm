import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CalendarSection } from "@/components/settings/calendar-section";
import type { BookableRange } from "@/lib/domain/bookable-hours";
import type { AgentCalendarRow, CalendarConnectionStatus } from "@/server/services/calendar-connection";

// The Disconnect and Save hours controls import server actions; rendering markup needs none of the server
// code behind them (same approach as tests/unit/booking/next-meeting.test.tsx).
vi.mock("@/server/actions/calendar-connection", () => ({
  saveBookableHoursAction: vi.fn(),
  disconnectCalendarAction: vi.fn(),
  provisionCalendarForAgentAction: vi.fn(),
}));

const TIME_ZONE = "America/New_York";
const NO_HOURS: BookableRange[] = [];
const AGENTS: AgentCalendarRow[] = [
  { userId: "11111111-1111-4111-8111-111111111111", name: "Maria Diaz", email: "maria@funnelmcqueen.test", hasCalendar: true },
  { userId: "22222222-2222-4222-8222-222222222222", name: "Sam Cole", email: "sam@funnelmcqueen.test", hasCalendar: false },
];

const NOT_CONNECTED: CalendarConnectionStatus = { connected: false, googleEmail: null, hoursSet: false, broken: false };
const CONNECTED: CalendarConnectionStatus = { connected: true, googleEmail: "closer@example.com", hoursSet: true, broken: false };
const CONNECTED_NO_HOURS: CalendarConnectionStatus = { connected: true, googleEmail: "closer@example.com", hoursSet: false, broken: false };
const BROKEN: CalendarConnectionStatus = { connected: true, googleEmail: "closer@example.com", hoursSet: true, broken: true };

function render(status: CalendarConnectionStatus, hours: BookableRange[] = NO_HOURS, agentCalendars: AgentCalendarRow[] = AGENTS): string {
  return renderToStaticMarkup(createElement(CalendarSection, { status, hours, agentCalendars, timeZone: TIME_ZONE }));
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

describe("CalendarSection agent calendars (D48)", () => {
  it("names everyone, says who still has no calendar, and never renders a calendar id", () => {
    const html = render(CONNECTED);
    expect(html).toContain("Maria Diaz");
    expect(html).toContain("Sam Cole");
    expect(html).toContain("Has a calendar");
    expect(html).toContain("1 person has no calendar yet, so they cannot book meetings.");
    expect(html).toContain("Create calendar");
    expect(html).not.toContain("@group.calendar.google.com");
  });

  it("says nothing is outstanding when everyone has a calendar", () => {
    const html = render(CONNECTED, NO_HOURS, [AGENTS[0]!]);
    expect(html).not.toContain("cannot book meetings");
    expect(html).not.toContain("Create calendar");
  });

  it("disables provisioning until an account is connected, and explains why", () => {
    const html = render(NOT_CONNECTED);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Create calendar<\/button>/);
    expect(html).toContain("Connect Google Calendar first, then give each person a calendar.");
  });

  it("disables provisioning while the connection is broken, since it would fail against Google", () => {
    const html = render(BROKEN);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Create calendar<\/button>/);
  });
});

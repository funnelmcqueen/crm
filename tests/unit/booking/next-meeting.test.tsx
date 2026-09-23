import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NextMeeting } from "@/components/booking/next-meeting";

// The cancel button imports a server action; rendering markup needs none of the server code behind it.
vi.mock("@/server/actions/calendar-booking", () => ({ cancelAppointmentAction: vi.fn() }));

const meeting = { id: "m1", start: "2026-09-18T21:00:00.000Z", end: "2026-09-18T21:30:00.000Z", bookedByName: "Casey Morgan", bookedByMe: false };
const now = new Date("2026-09-17T14:00:00Z");

describe("NextMeeting", () => {
  it("phrases the meeting in the lead's time for an agent, without who booked it", () => {
    const html = renderToStaticMarkup(createElement(NextMeeting, { meeting, timeZone: "America/New_York", now, isAdmin: false }));
    expect(html).toContain("Next meeting:");
    expect(html).toContain("Tomorrow at 5 pm EDT");
    expect(html).not.toContain("Casey Morgan");
    expect(html).not.toContain("Mark cancelled");
  });

  it("offers the cancel control to the agent who booked it (D48)", () => {
    const mine = { ...meeting, bookedByMe: true };
    const html = renderToStaticMarkup(createElement(NextMeeting, { meeting: mine, timeZone: "America/New_York", now, isAdmin: false }));
    expect(html).toContain("Mark cancelled");
    // Still not told who booked it: that line is the admin's, and an agent only ever sees their own meetings.
    expect(html).not.toContain("Casey Morgan");
  });

  it("shows the booker and the cancel control to an admin", () => {
    const html = renderToStaticMarkup(createElement(NextMeeting, { meeting, timeZone: "America/New_York", now, isAdmin: true }));
    expect(html).toContain("Booked by Casey Morgan");
    expect(html).toContain("Mark cancelled");
  });
});

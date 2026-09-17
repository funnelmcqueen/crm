import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NextMeeting } from "@/components/booking/next-meeting";

// The cancel button imports a server action; rendering markup needs none of the server code behind it.
vi.mock("@/server/actions/calendar-booking", () => ({ cancelAppointmentAction: vi.fn() }));

const meeting = { id: "m1", start: "2026-09-18T21:00:00.000Z", end: "2026-09-18T21:30:00.000Z", bookedByName: "Casey Morgan" };
const now = new Date("2026-09-17T14:00:00Z");

describe("NextMeeting", () => {
  it("phrases the meeting in the lead's time for an agent, without who booked it", () => {
    const html = renderToStaticMarkup(createElement(NextMeeting, { meeting, timeZone: "America/New_York", now, isAdmin: false }));
    expect(html).toContain("Next meeting:");
    expect(html).toContain("Tomorrow at 5 pm EDT");
    expect(html).not.toContain("Casey Morgan");
    expect(html).not.toContain("Mark cancelled");
  });

  it("shows the booker and the cancel control to an admin", () => {
    const html = renderToStaticMarkup(createElement(NextMeeting, { meeting, timeZone: "America/New_York", now, isAdmin: true }));
    expect(html).toContain("Booked by Casey Morgan");
    expect(html).toContain("Mark cancelled");
  });
});

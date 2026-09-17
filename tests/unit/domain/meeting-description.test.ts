import { describe, expect, it } from "vitest";
import { buildMeetingDescription, meetingTitle } from "@/lib/domain/meeting-description";

describe("meeting text", () => {
  it("titles the event after the business", () => {
    expect(meetingTitle("Swan Motel")).toBe("Meeting: Swan Motel");
  });

  it("puts everything the closer needs in the description", () => {
    expect(
      buildMeetingDescription({
        businessName: "Kompose Hotel Sarasota",
        contactName: "Erica",
        phone: "+19413301160",
        city: "Sarasota",
        state: "FL",
        bookedBy: "Casey Morgan",
        note: "Wants the OTA fix",
        leadUrl: "https://crm.example.com/leads/abc",
      }),
    ).toBe(
      [
        "Contact: Erica",
        "Phone: (941) 330-1160 (+19413301160)",
        "Location: Sarasota, FL",
        "Booked by Casey Morgan",
        "Note: Wants the OTA fix",
        "Lead: https://crm.example.com/leads/abc",
      ].join("\n"),
    );
  });

  it("leaves out what is missing", () => {
    expect(
      buildMeetingDescription({ businessName: "X", contactName: null, phone: "+19413301160", city: null, state: null, bookedBy: "Casey", note: null, leadUrl: null }),
    ).toBe("Phone: (941) 330-1160 (+19413301160)\nBooked by Casey");
  });
});

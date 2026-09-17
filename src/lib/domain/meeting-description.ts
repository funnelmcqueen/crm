// Title and description of the meeting event on the closer's calendar (docs/DEVIATIONS.md D46). The closer confirms
// with the lead personally, so the phone number is always there.
import { formatPhoneDisplay } from "./phone";

export interface MeetingDescriptionInput {
  businessName: string;
  contactName: string | null;
  phone: string;
  city: string | null;
  state: string | null;
  bookedBy: string;
  note: string | null;
  leadUrl: string | null;
}

export function meetingTitle(businessName: string): string {
  return `Meeting: ${businessName}`;
}

export function buildMeetingDescription(input: MeetingDescriptionInput): string {
  const place = [input.city, input.state].filter((part): part is string => !!part && part.trim() !== "").join(", ");
  return [
    input.contactName ? `Contact: ${input.contactName}` : null,
    `Phone: ${formatPhoneDisplay(input.phone)} (${input.phone})`,
    place ? `Location: ${place}` : null,
    `Booked by ${input.bookedBy}`,
    input.note ? `Note: ${input.note}` : null,
    input.leadUrl ? `Lead: ${input.leadUrl}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

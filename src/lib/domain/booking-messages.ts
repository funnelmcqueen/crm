// Messages the booking service raises and the booking panel recognises (docs/DEVIATIONS.md D46). Client-safe: no
// server imports, so the panel compares against these exact strings instead of matching text.

export const BOOKING_UNAVAILABLE_MESSAGE = "Booking isn't available right now. Schedule a follow-up instead.";
export const CALENDAR_LOAD_FAILED_MESSAGE = "Couldn't load the calendar. Try again.";
export const SLOT_TAKEN_MESSAGE = "That time was just taken. Pick another.";
export const BOOKING_FAILED_MESSAGE = "Couldn't book the meeting. Nothing was saved. Try again.";
export const STATUS_NOT_UPDATED_MESSAGE = "Booked, but the lead's status didn't change. Set it to Appointment by hand.";

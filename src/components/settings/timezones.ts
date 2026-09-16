// Curated IANA zones for pickers. A static list renders identically on the server and in every browser;
// the server validates any value with isValidTimeZone, and a current value outside the list is still shown.

export const COMMON_TIME_ZONES: readonly string[] = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
  "America/Halifax",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "America/Bogota",
  "America/Lima",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Rome",
  "Europe/Warsaw",
  "Europe/Athens",
  "Europe/Istanbul",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Africa/Cairo",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Manila",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Australia/Perth",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
];

/** The list with `current` added (first) when it is not already in it. */
export function timeZoneOptions(current: string | null | undefined): string[] {
  const value = current?.trim();
  return value && !COMMON_TIME_ZONES.includes(value) ? [value, ...COMMON_TIME_ZONES] : [...COMMON_TIME_ZONES];
}

/** "America/Los_Angeles" -> "Los Angeles (America)". */
export function timeZoneLabel(tz: string): string {
  if (tz === "UTC") return "UTC";
  const parts = tz.split("/");
  const city = (parts[parts.length - 1] ?? tz).replace(/_/g, " ");
  return parts.length > 1 ? `${city} (${parts[0].replace(/_/g, " ")})` : city;
}

import "server-only";
import { getCalendarDriver, type ServerEnv } from "@/server/env";
import { createGoogleCalendar, type GoogleCalendarDeps } from "./google";
import { createMockCalendar } from "./mock";
import type { CalendarClient } from "./types";

/**
 * The calendar for the configured driver, or null when booking is unavailable (no driver in production, an invalid
 * environment, or a Google driver with no usable connection). `timeZone` is the company zone, `ownerId` whose
 * calendar it is — the mock keeps one per owner, like the Google driver (D48).
 * This resolver never queries the database: the Google path is reached through `resolveGoogleCalendar` below,
 * once the caller (src/server/services/calendar-connection.ts, Task 6) has loaded a connection and hours.
 */
export function resolveCalendarClient(timeZone: string, ownerId: string, env?: ServerEnv): CalendarClient | null {
  let driver: ReturnType<typeof getCalendarDriver>;
  try {
    driver = getCalendarDriver(env);
  } catch {
    return null;
  }
  return driver === "mock" ? createMockCalendar(timeZone, ownerId) : null;
}

/**
 * The Google-backed calendar for an already-loaded connection and bookable hours (docs/DEVIATIONS.md D47). Unlike
 * `resolveCalendarClient`, this never resolves the driver or touches the database itself — the caller reads the
 * connection row and the hours and passes them in through `deps`.
 */
export function resolveGoogleCalendar(deps: GoogleCalendarDeps): CalendarClient {
  return createGoogleCalendar(deps);
}

/** Whether the calendar driver currently resolves to google, treating an unparseable environment as "no". */
export function isGoogleDriver(env?: ServerEnv): boolean {
  try {
    return getCalendarDriver(env) === "google";
  } catch {
    return false;
  }
}

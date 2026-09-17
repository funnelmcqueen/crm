import "server-only";
import { getCalendarDriver, type ServerEnv } from "@/server/env";
import { createMockCalendar } from "./mock";
import type { CalendarClient } from "./types";

/**
 * The calendar for the configured driver, or null when booking is unavailable (no driver in production, an invalid
 * environment, or the Google driver before Plan 2 adds it). `timeZone` is the closer's zone for the mock calendar.
 */
export function resolveCalendarClient(timeZone: string, env?: ServerEnv): CalendarClient | null {
  let driver: ReturnType<typeof getCalendarDriver>;
  try {
    driver = getCalendarDriver(env);
  } catch {
    return null;
  }
  return driver === "mock" ? createMockCalendar(timeZone) : null;
}

"use server";

import { refresh } from "next/cache";
import type { BookableRange } from "@/lib/domain/bookable-hours";
import { getActionContext } from "@/server/context";
import { runAction, type ActionResult } from "@/server/errors";
import { disconnectCalendar, saveBookableHours } from "@/server/services/calendar-connection";

// Thin wrappers: the service validates every argument and checks the session and role.

export async function saveBookableHoursAction(ranges: BookableRange[]): Promise<ActionResult<BookableRange[]>> {
  const result = await runAction(async () => saveBookableHours(await getActionContext(), ranges));
  if (result.ok) refresh();
  return result;
}

export async function disconnectCalendarAction(): Promise<ActionResult<void>> {
  const result = await runAction(async () => disconnectCalendar(await getActionContext()));
  if (result.ok) refresh();
  return result;
}

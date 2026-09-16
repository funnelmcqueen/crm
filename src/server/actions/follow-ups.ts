"use server";

import { refresh } from "next/cache";
import { getActionContext } from "@/server/context";
import { runAction, type ActionResult } from "@/server/errors";
import { completeFollowUp, rescheduleFollowUpTo, type RescheduleChoice } from "@/server/services/follow-ups";

// Thin wrappers: the services validate every argument with Zod and check the session.

export async function completeFollowUpAction(
  followUpId: string,
): Promise<ActionResult<{ id: string; completedAt: string }>> {
  const result = await runAction(async () => completeFollowUp(await getActionContext(), followUpId));
  if (result.ok) refresh();
  return result;
}

/** The due time is resolved on the server in the caller's profile time zone. */
export async function rescheduleFollowUpAction(
  followUpId: string,
  choice: RescheduleChoice,
): Promise<ActionResult<{ id: string; dueAt: string }>> {
  const result = await runAction(async () => rescheduleFollowUpTo(await getActionContext(), followUpId, choice));
  if (result.ok) refresh();
  return result;
}

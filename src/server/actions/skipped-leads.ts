"use server";

import { refresh } from "next/cache";
import { getActionContext } from "@/server/context";
import { runAction, type ActionResult } from "@/server/errors";
import { resumeSkippedLead, skipLead } from "@/server/services/skipped-leads";
import type { SkipReason } from "@/lib/domain/skips";

// Thin wrappers: the services validate every argument with Zod and check the session.

/** Saves the skip. The Next Lead flow navigates on, so this does not refresh the page it leaves. */
export async function skipLeadAction(
  leadId: string,
  reason: SkipReason | null,
  note?: string | null,
): Promise<ActionResult<{ skipId: string; leadId: string }>> {
  return runAction(async () => skipLead(await getActionContext(), leadId, { reason, note }));
}

export async function resumeSkippedLeadAction(leadId: string): Promise<ActionResult<{ leadId: string; resumed: number }>> {
  const result = await runAction(async () => resumeSkippedLead(await getActionContext(), leadId));
  if (result.ok) refresh();
  return result;
}

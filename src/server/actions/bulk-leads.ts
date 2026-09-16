"use server";

import { refresh } from "next/cache";
import type {
  BulkAssignResult,
  BulkCountResult,
  BulkFollowUpResult,
  BulkStatusResult,
  BulkUndo,
  BulkUndoResult,
} from "@/lib/domain/bulk-leads";
import { getActionContext } from "@/server/context";
import { AppError, runAction, type ActionResult } from "@/server/errors";
import {
  bulkAssign,
  bulkCompleteFollowUps,
  bulkDelete,
  bulkScheduleFollowUp,
  bulkSetSource,
  bulkUpdateStatus,
  listMatchingLeadIds,
  undoBulkAssign,
  undoBulkStatus,
  type MatchingLeadFilters,
  type MatchingLeadIds,
} from "@/server/services/bulk-leads";

// Thin wrappers: the services validate every argument with Zod and check the session and role. Each change
// refreshes the current page; Pipeline, Dashboard, Follow-ups and Reports are rendered per request, so they show
// the change the next time they are opened.

export async function listMatchingLeadIdsAction(filters: MatchingLeadFilters): Promise<ActionResult<MatchingLeadIds>> {
  return runAction(async () => listMatchingLeadIds(await getActionContext(), filters));
}

export async function bulkUpdateStatusAction(leadIds: string[], status: string): Promise<ActionResult<BulkStatusResult>> {
  const result = await runAction(async () => bulkUpdateStatus(await getActionContext(), leadIds, status));
  if (result.ok) refresh();
  return result;
}

export async function bulkAssignAction(leadIds: string[], toUserId: string | null): Promise<ActionResult<BulkAssignResult>> {
  const result = await runAction(async () => bulkAssign(await getActionContext(), leadIds, toUserId));
  if (result.ok) refresh();
  return result;
}

export async function undoBulkChangeAction(undo: BulkUndo): Promise<ActionResult<BulkUndoResult>> {
  const result = await runAction(async () => {
    const ctx = await getActionContext();
    const kind = (undo as { kind?: unknown } | null)?.kind;
    if (kind === "status") return undoBulkStatus(ctx, undo);
    if (kind === "assign") return undoBulkAssign(ctx, undo);
    throw new AppError("validation", "There is nothing to undo.");
  });
  if (result.ok) refresh();
  return result;
}

export async function bulkScheduleFollowUpAction(
  leadIds: string[],
  dueAtIso: string,
  note?: string | null,
): Promise<ActionResult<BulkFollowUpResult>> {
  const result = await runAction(async () => bulkScheduleFollowUp(await getActionContext(), leadIds, dueAtIso, note));
  if (result.ok) refresh();
  return result;
}

export async function bulkCompleteFollowUpsAction(leadIds: string[]): Promise<ActionResult<BulkCountResult>> {
  const result = await runAction(async () => bulkCompleteFollowUps(await getActionContext(), leadIds));
  if (result.ok) refresh();
  return result;
}

export async function bulkSetSourceAction(
  leadIds: string[],
  source: string | null,
): Promise<ActionResult<BulkCountResult & { source: string | null }>> {
  const result = await runAction(async () => bulkSetSource(await getActionContext(), leadIds, source));
  if (result.ok) refresh();
  return result;
}

export async function bulkDeleteAction(leadIds: string[]): Promise<ActionResult<BulkCountResult>> {
  const result = await runAction(async () => bulkDelete(await getActionContext(), leadIds));
  if (result.ok) refresh();
  return result;
}

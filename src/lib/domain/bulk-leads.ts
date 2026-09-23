// Bulk lead actions (docs/DEVIATIONS.md D41): limits, result shapes and the messages shown after an action.
// Shared by the server services and the Leads page, so a count reads the same everywhere.
import { BUSINESS_TYPE_LABELS, type BusinessType } from "./business-type";
import { STATUS_LABELS, type LeadStatus } from "./statuses";

/** The most leads one selection (and one bulk request) may hold. The SQL functions enforce the same cap. */
export const MAX_BULK_LEADS = 5000;
export const MAX_BULK_NOTE_LENGTH = 500;

/** Status undo: the ids that had each previous status, reverted only while they still hold `applied`. */
export interface BulkStatusUndo {
  kind: "status";
  applied: LeadStatus;
  groups: Array<{ status: LeadStatus; ids: string[] }>;
}

/** Assignment undo: the ids each previous owner had (null = unassigned), reverted while still on `applied`. */
export interface BulkAssignUndo {
  kind: "assign";
  applied: string | null;
  groups: Array<{ assignedTo: string | null; ids: string[] }>;
}

export type BulkUndo = BulkStatusUndo | BulkAssignUndo;

export interface BulkStatusResult {
  requested: number;
  updated: number;
  unchanged: number;
  /** Do Not Contact leads an agent may not reopen (DEVIATIONS D12). */
  locked: number;
  /** Deleted, reassigned away, or never visible to the caller. */
  missing: number;
  undo: BulkStatusUndo | null;
}

export interface BulkAssignResult {
  requested: number;
  updated: number;
  unchanged: number;
  missing: number;
  undo: BulkAssignUndo | null;
}

export interface BulkFollowUpResult {
  requested: number;
  created: number;
  rescheduled: number;
  missing: number;
}

export interface BulkCountResult {
  requested: number;
  count: number;
}

export interface BulkUndoResult {
  restored: number;
  /** Leads changed again since the bulk action, which undo leaves alone. */
  skipped: number;
  /** Previous owners who can no longer take leads (disabled or deleted): their leads stay where they are. */
  failed: number;
}

export function leadCount(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "lead" : "leads"}`;
}

function sentence(parts: Array<string | null>): string {
  return parts.filter((part): part is string => part !== null).join(" ");
}

function notChanged(unchanged: number, locked: number, missing: number, unchangedWhy: string): string | null {
  const notes: string[] = [];
  if (unchanged > 0) notes.push(`${leadCount(unchanged)} ${unchangedWhy}`);
  if (locked > 0) notes.push(`${leadCount(locked)} marked Do Not Contact ${locked === 1 ? "stays" : "stay"} as ${locked === 1 ? "it is" : "they are"} (only an admin can reopen them)`);
  if (missing > 0) notes.push(`${leadCount(missing)} ${missing === 1 ? "is" : "are"} no longer available`);
  return notes.length > 0 ? `${notes.join("; ")}.` : null;
}

export function describeStatusResult(result: BulkStatusResult, status: LeadStatus): string {
  const label = STATUS_LABELS[status];
  return sentence([
    result.updated > 0 ? `Moved ${leadCount(result.updated)} to ${label}.` : `No leads moved to ${label}.`,
    notChanged(result.unchanged, result.locked, result.missing, `already ${result.unchanged === 1 ? "was" : "were"} ${label}`),
  ]);
}

export function describeAssignResult(result: BulkAssignResult, agentName: string | null): string {
  const target = agentName === null ? "Unassigned" : agentName;
  const head =
    result.updated === 0
      ? agentName === null
        ? "No leads were unassigned."
        : `No leads were assigned to ${target}.`
      : agentName === null
        ? `Unassigned ${leadCount(result.updated)}.`
        : `Assigned ${leadCount(result.updated)} to ${target}.`;
  return sentence([
    head,
    notChanged(result.unchanged, 0, result.missing, agentName === null ? `already ${result.unchanged === 1 ? "was" : "were"} unassigned` : `already ${result.unchanged === 1 ? "was" : "were"} ${target}'s`),
  ]);
}

export function describeFollowUpResult(result: BulkFollowUpResult): string {
  const done = result.created + result.rescheduled;
  const detail: string[] = [];
  if (result.created > 0) detail.push(`${result.created.toLocaleString("en-US")} new`);
  if (result.rescheduled > 0) detail.push(`${result.rescheduled.toLocaleString("en-US")} rescheduled`);
  return sentence([
    done > 0 ? `Follow-up set on ${leadCount(done)} (${detail.join(", ")}).` : "No follow-ups were set.",
    notChanged(0, 0, result.missing, ""),
  ]);
}

export function describeCompletedFollowUps(result: BulkCountResult): string {
  return result.count === 0
    ? "There were no open follow-ups to clear on these leads."
    : `Cleared ${result.count.toLocaleString("en-US")} open ${result.count === 1 ? "follow-up" : "follow-ups"}.`;
}

export function describeSourceResult(result: BulkCountResult, source: string | null): string {
  const what = source === null ? "Cleared the source on" : `Set the source to "${source}" on`;
  const head = result.count > 0 ? `${what} ${leadCount(result.count)}.` : "No sources changed.";
  const same = result.requested - result.count;
  return sentence([head, same > 0 && result.count > 0 ? `${leadCount(same)} already had it or ${same === 1 ? "is" : "are"} no longer available.` : null]);
}

export function describeBusinessTypeResult(result: BulkCountResult, type: BusinessType | null): string {
  if (result.count === 0) return "No business types changed.";
  if (type === null) {
    return `Cleared the business type on ${leadCount(result.count)}, so ${result.count === 1 ? "its name decides" : "their names decide"} again.`;
  }
  const head = `Set the business type to ${BUSINESS_TYPE_LABELS[type]} on ${leadCount(result.count)}.`;
  const same = result.requested - result.count;
  return sentence([head, same > 0 ? `${leadCount(same)} already had it or ${same === 1 ? "is" : "are"} no longer available.` : null]);
}

export function describeDeleteResult(result: BulkCountResult): string {
  return result.count > 0 ? `Deleted ${leadCount(result.count)}.` : "No leads were deleted.";
}

export function describeUndoResult(result: BulkUndoResult): string {
  return sentence([
    result.restored > 0 ? `Undid the change on ${leadCount(result.restored)}.` : "Nothing to undo.",
    result.skipped > 0 ? `${leadCount(result.skipped)} changed again since, so ${result.skipped === 1 ? "it was" : "they were"} left alone.` : null,
    result.failed > 0 ? `${leadCount(result.failed)} could not go back to an agent who is no longer active.` : null,
  ]);
}

// Leads page selection rules (docs/DEVIATIONS.md D41), kept pure so they can be unit tested.
//
// A selection belongs to one *scope*: the signed-in role plus the list's search and filters. Sorting and paging
// do not change the scope, so a selection is kept while the agent pages or re-sorts the same result set. Any
// change to search or filters is a different result set, so the selection starts empty again (and says so).
import { MAX_BULK_LEADS } from "@/lib/domain/bulk-leads";
import type { LeadListParams } from "../list-params";

export type HeaderCheckState = "checked" | "indeterminate" | "unchecked";

export function selectionScope(role: "ADMIN" | "AGENT", params: Pick<LeadListParams, "q" | "statuses" | "source" | "agent" | "unassigned">): string {
  return JSON.stringify([
    role,
    params.q.trim().toLowerCase(),
    [...params.statuses].sort(),
    params.source ?? "",
    role === "ADMIN" ? (params.unassigned ? "unassigned" : (params.agent ?? "")) : "",
  ]);
}

/** The header checkbox reflects the rows on the current page only. */
export function headerCheckState(pageIds: readonly string[], selected: ReadonlySet<string>): HeaderCheckState {
  if (pageIds.length === 0) return "unchecked";
  let count = 0;
  for (const id of pageIds) if (selected.has(id)) count += 1;
  if (count === 0) return "unchecked";
  return count === pageIds.length ? "checked" : "indeterminate";
}

/** Selects every row on the page, or clears them when they are all selected already. Never exceeds the cap. */
export function togglePage(pageIds: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (headerCheckState(pageIds, selected) === "checked") {
    for (const id of pageIds) next.delete(id);
    return next;
  }
  for (const id of pageIds) {
    if (next.size >= MAX_BULK_LEADS) break;
    next.add(id);
  }
  return next;
}

/**
 * One row click. With `anchor` (shift-click) every row between the last clicked row and this one takes this
 * row's new state, the way file lists behave. Unknown anchors fall back to a single toggle.
 */
export function toggleRow(
  pageIds: readonly string[],
  selected: ReadonlySet<string>,
  id: string,
  anchor: string | null = null,
): Set<string> {
  const next = new Set(selected);
  const select = !selected.has(id);
  const to = pageIds.indexOf(id);
  const from = anchor === null ? -1 : pageIds.indexOf(anchor);
  const range = from >= 0 && to >= 0 ? pageIds.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
  for (const rowId of range) {
    if (select) {
      if (next.size >= MAX_BULK_LEADS && !next.has(rowId)) break;
      next.add(rowId);
    } else {
      next.delete(rowId);
    }
  }
  return next;
}

/** "Select all 1,240 matching" / "Select the first 5,000 of 7,300 matching", or null when there is nothing more. */
export function selectAllMatchingLabel(selectedCount: number, total: number): string | null {
  const reachable = Math.min(total, MAX_BULK_LEADS);
  if (total <= 1 || selectedCount >= reachable) return null;
  return total > MAX_BULK_LEADS
    ? `Select the first ${MAX_BULK_LEADS.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`
    : `Select all ${total.toLocaleString("en-US")} matching`;
}

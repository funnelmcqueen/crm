"use client";

import { createContext, useCallback, useContext, useMemo, useRef, type MouseEvent, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { MatchingLeadFilters } from "@/server/services/bulk-leads";
import { headerCheckState, togglePage, toggleRow } from "./selection";
import { useLeadSelection, type LeadSelection } from "./selection-store";

export interface LeadSelectionContextValue extends LeadSelection {
  scope: string;
  /** Ids on the current page, in display order. */
  pageIds: readonly string[];
  /** Every lead matching the current search and filters. */
  total: number;
  filters: MatchingLeadFilters;
  isAdmin: boolean;
  toggle(id: string, extendRange: boolean): void;
  togglePage(): void;
}

const LeadSelectionContext = createContext<LeadSelectionContextValue | null>(null);

export function useLeadSelectionContext(): LeadSelectionContextValue {
  const value = useContext(LeadSelectionContext);
  if (!value) throw new Error("useLeadSelectionContext must be used inside LeadSelectionProvider");
  return value;
}

export interface LeadSelectionProviderProps {
  scope: string;
  pageIds: string[];
  total: number;
  filters: MatchingLeadFilters;
  isAdmin: boolean;
  children: ReactNode;
}

export function LeadSelectionProvider({ scope, pageIds, total, filters, isAdmin, children }: LeadSelectionProviderProps) {
  const selection = useLeadSelection(scope);
  const anchor = useRef<string | null>(null);
  const { ids, replace } = selection;

  const toggle = useCallback(
    (id: string, extendRange: boolean) => {
      replace(toggleRow(pageIds, ids, id, extendRange ? anchor.current : null));
      anchor.current = id;
    },
    [ids, pageIds, replace],
  );
  const toggleAllOnPage = useCallback(() => {
    replace(togglePage(pageIds, ids));
    anchor.current = null;
  }, [ids, pageIds, replace]);

  const value = useMemo<LeadSelectionContextValue>(
    () => ({ ...selection, scope, pageIds, total, filters, isAdmin, toggle, togglePage: toggleAllOnPage }),
    [selection, scope, pageIds, total, filters, isAdmin, toggle, toggleAllOnPage],
  );
  return <LeadSelectionContext.Provider value={value}>{children}</LeadSelectionContext.Provider>;
}

export interface LeadSelectCheckboxProps {
  leadId: string;
  businessName: string;
  className?: string;
}

/** A row or card checkbox. Shift-click selects the range from the previous click. */
export function LeadSelectCheckbox({ leadId, businessName, className }: LeadSelectCheckboxProps) {
  const { ids, toggle } = useLeadSelectionContext();
  const checked = ids.has(leadId);
  return (
    <Checkbox
      checked={checked}
      aria-label={`Select ${businessName}`}
      className={cn("size-5 [&_[data-slot=checkbox-indicator]>svg]:size-4", className)}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        toggle(leadId, event.shiftKey);
      }}
    />
  );
}

/** Header checkbox for the rows on this page: unchecked, checked, or indeterminate (some selected). */
export function LeadSelectPageCheckbox({ className }: { className?: string }) {
  const { ids, pageIds, togglePage: toggleAll } = useLeadSelectionContext();
  const state = headerCheckState(pageIds, ids);
  const label =
    state === "checked"
      ? `Deselect the ${pageIds.length} ${pageIds.length === 1 ? "lead" : "leads"} on this page`
      : `Select the ${pageIds.length} ${pageIds.length === 1 ? "lead" : "leads"} on this page`;
  return (
    <Checkbox
      checked={state === "checked" ? true : state === "indeterminate" ? "indeterminate" : false}
      aria-label={label}
      disabled={pageIds.length === 0}
      className={cn("size-5 [&_[data-slot=checkbox-indicator]>svg]:size-4", className)}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        toggleAll();
      }}
    />
  );
}

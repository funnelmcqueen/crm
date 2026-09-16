"use client";

import { UserPlus } from "lucide-react";
import Link from "next/link";
import { useTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { leadCount } from "@/lib/domain/bulk-leads";
import { listMatchingLeadIdsAction } from "@/server/actions/bulk-leads";
import { useLeadSelectionContext } from "./selection-context";

export interface UnassignedCalloutProps {
  /** Every unassigned lead in the system. */
  unassigned: number;
  /** The list is already filtered to unassigned leads (and nothing else). */
  showingUnassigned: boolean;
  unassignedHref: string;
}

/**
 * Admin only. Unassigned leads never reach anyone's call queue, so the Leads page makes assigning them the
 * obvious next step: a link to the unassigned view, and there a one-click "select them all" that opens the
 * bulk bar with Assign first. Hidden while a selection is active (the bulk bar takes over).
 */
export function UnassignedCallout({ unassigned, showingUnassigned, unassignedHref }: UnassignedCalloutProps) {
  const selection = useLeadSelectionContext();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (unassigned === 0 || selection.count > 0) return null;

  function selectAll() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await listMatchingLeadIdsAction(selection.filters);
        if (result.ok) selection.replace(result.data.ids);
        else setError(result.error.message);
      } catch {
        setError("Could not select the unassigned leads. Try again.");
      }
    });
  }

  return (
    <section
      aria-label="Unassigned leads"
      className="mb-3 flex flex-col gap-3 rounded-xl border border-primary/40 bg-primary/5 p-3 sm:flex-row sm:items-center md:px-4"
    >
      <UserPlus aria-hidden className="hidden size-6 shrink-0 text-primary sm:block" />
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-extrabold">{leadCount(unassigned)}</span> {unassigned === 1 ? "has" : "have"} no agent and{" "}
        {unassigned === 1 ? "is" : "are"} not in anyone&rsquo;s call queue.
        {showingUnassigned && selection.total > 0 ? " Select them to assign them in one go." : null}
      </p>
      {showingUnassigned ? (
        selection.total > 0 ? (
          <Button className="h-12 px-5 font-bold" disabled={pending} onClick={selectAll}>
            {pending ? "Selecting…" : `Select ${leadCount(Math.min(selection.total, 5000))} to assign`}
          </Button>
        ) : null
      ) : (
        <Button asChild className="h-12 px-5 font-bold">
          <Link href={unassignedHref}>Review unassigned</Link>
        </Button>
      )}
      <p role="status" aria-live="polite" className={error ? "text-sm font-semibold text-destructive" : "sr-only"}>
        {error ?? ""}
      </p>
    </section>
  );
}

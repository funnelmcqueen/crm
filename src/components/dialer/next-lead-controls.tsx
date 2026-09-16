"use client";

// Rendered on the lead detail page when it was opened from the Next Lead flow (?flow=next).
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { NEXT_LEAD_REASON_LABELS, appendSkip, isNextLeadReason, nextLeadHref, parseSkipParam } from "@/lib/dialer/skip-list";
import { useDialer } from "./dialer-context";
import { SkipLeadMenu } from "./skip-lead-menu";

export interface NextLeadControlsProps {
  leadId: string;
  businessName: string;
}

function Controls({ leadId, businessName }: NextLeadControlsProps) {
  const searchParams = useSearchParams();
  const dialer = useDialer();
  const reason = searchParams.get("reason");
  const busy = dialer !== null && dialer.state.kind !== "idle";
  // A saved skip keeps the lead out of get_next_lead, so the session skip list only carries earlier fallbacks.
  const sessionSkips = parseSkipParam(searchParams.get("skip"));

  return (
    <div className="flex items-center justify-between gap-3">
      {isNextLeadReason(reason) ? (
        <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
          Next lead · {NEXT_LEAD_REASON_LABELS[reason]}
        </span>
      ) : (
        <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Next lead</span>
      )}
      <SkipLeadMenu
        leadId={leadId}
        businessName={businessName}
        disabled={busy}
        nextHref={nextLeadHref(sessionSkips)}
        fallbackHref={nextLeadHref(appendSkip(sessionSkips, leadId))}
      />
    </div>
  );
}

export function NextLeadControls({ leadId, businessName }: NextLeadControlsProps) {
  return (
    <Suspense fallback={null}>
      <Controls leadId={leadId} businessName={businessName} />
    </Suspense>
  );
}

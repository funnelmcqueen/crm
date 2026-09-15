"use client";

// Rendered on the lead detail page when it was opened from the Next Lead flow (?flow=next).
import { SkipForward } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { NEXT_LEAD_REASON_LABELS, appendSkip, isNextLeadReason, nextLeadHref, parseSkipParam } from "@/lib/dialer/skip-list";
import { useDialer } from "./dialer-context";

export interface NextLeadControlsProps {
  leadId: string;
}

function Controls({ leadId }: NextLeadControlsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialer = useDialer();
  const reason = searchParams.get("reason");
  const busy = dialer !== null && dialer.state.kind !== "idle";

  return (
    <div className="flex items-center justify-between gap-3">
      {isNextLeadReason(reason) ? (
        <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
          Next lead · {NEXT_LEAD_REASON_LABELS[reason]}
        </span>
      ) : (
        <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Next lead</span>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => router.push(nextLeadHref(appendSkip(parseSkipParam(searchParams.get("skip")), leadId)))}
        className="inline-flex min-h-12 items-center gap-2 rounded-xl border bg-card px-5 text-base font-bold outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 [&_svg]:size-5"
      >
        <SkipForward aria-hidden />
        Skip
      </button>
    </div>
  );
}

export function NextLeadControls({ leadId }: NextLeadControlsProps) {
  return (
    <Suspense fallback={null}>
      <Controls leadId={leadId} />
    </Suspense>
  );
}

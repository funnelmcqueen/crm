"use client";

import { SkipForward } from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { toast } from "sonner";
import { DateTime } from "@/components/common/datetime";
import { Button } from "@/components/ui/button";
import { SKIP_RESOLUTION_LABELS, describeSkipReason } from "@/lib/domain/skips";
import { resumeSkippedLeadAction } from "@/server/actions/skipped-leads";
import type { LeadSkipEntry } from "@/server/services/skipped-leads";

export interface OpenSkipNoticeProps {
  leadId: string;
  skip: LeadSkipEntry;
  tz: string;
  now: number;
  /** Admin viewing another agent's skip: Resume hands the lead back to that agent's queue. */
  forAgent: string | null;
}

/** Shown on a lead that is waiting in the Skipped queue (docs/DEVIATIONS.md D42). */
export function OpenSkipNotice({ leadId, skip, tz, now, forAgent }: OpenSkipNoticeProps) {
  const [pending, startTransition] = useTransition();

  function resume() {
    startTransition(async () => {
      const result = await resumeSkippedLeadAction(leadId);
      if (result.ok) toast.success(forAgent ? `Back in ${forAgent}'s call queue` : "Back in your call queue");
      else toast.error(result.error.message);
    });
  }

  return (
    <div role="status" className="mb-4 flex flex-col gap-3 rounded-xl border border-gold/50 bg-gold/10 p-4 text-sm sm:flex-row sm:items-center">
      <SkipForward aria-hidden className="hidden size-5 shrink-0 text-gold sm:block" />
      <p className="min-w-0 flex-1">
        <span className="font-bold">Skipped</span>{" "}
        {skip.skippedBy ? <>by {skip.skippedBy} </> : null}
        <DateTime value={skip.skippedAt} tz={tz} now={now} />. {describeSkipReason(skip.reason, skip.note)}. It stays out of
        the call queue until it is resumed, called, rescheduled or changes status.
      </p>
      <div className="flex gap-2">
        <Button asChild variant="ghost" className="h-12 px-3">
          <Link href="/follow-ups?tab=skipped">Skipped queue</Link>
        </Button>
        <Button className="h-12 px-4 font-bold" disabled={pending} onClick={resume}>
          {pending ? "Resuming…" : "Resume"}
        </Button>
      </div>
    </div>
  );
}

export interface SkipHistoryProps {
  entries: LeadSkipEntry[];
  tz: string;
  now: number;
}

/** Past and current skips on the lead, newest first. */
export function SkipHistory({ entries, tz, now }: SkipHistoryProps) {
  return (
    <ol className="flex flex-col divide-y">
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-col gap-0.5 py-2 text-sm first:pt-0 last:pb-0">
          <p className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="font-semibold">
              <DateTime value={entry.skippedAt} tz={tz} now={now} />
              {entry.skippedBy ? <span className="font-normal text-muted-foreground"> · {entry.skippedBy}</span> : null}
            </span>
            <span className="text-xs text-muted-foreground">
              {entry.resolution ? (
                <>
                  {SKIP_RESOLUTION_LABELS[entry.resolution]} <DateTime value={entry.resolvedAt} tz={tz} now={now} />
                </>
              ) : (
                <span className="font-semibold text-foreground">Waiting in Skipped</span>
              )}
            </span>
          </p>
          <p className="break-words text-muted-foreground">{describeSkipReason(entry.reason, entry.note)}</p>
        </li>
      ))}
    </ol>
  );
}

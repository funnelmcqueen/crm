"use client";

import { ChevronDown, SkipForward } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MAX_SKIP_NOTE_LENGTH, SKIP_REASON_LABELS, type SkipReason } from "@/lib/domain/skips";
import { cn } from "@/lib/utils";
import { resumeSkippedLeadAction, skipLeadAction } from "@/server/actions/skipped-leads";

const QUICK_REASONS: readonly SkipReason[] = ["CALL_LATER", "NEEDS_RESEARCH", "BAD_DATA", "NOT_PRIORITY"];

export interface SkipLeadMenuProps {
  leadId: string;
  businessName: string;
  /** Where to go once the skip is saved (the next lead), or null to refresh the current page. */
  nextHref: string | null;
  /** Where to go when saving fails: the same flow with this lead left out for this session only. */
  fallbackHref: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Skip with an optional reason (docs/DEVIATIONS.md D42). The skip is saved, so the lead waits in
 * Follow-ups > Skipped instead of coming back to the call queue; the toast offers Undo. If saving fails the
 * agent still moves on, with the lead left out of this session's queue only.
 */
export function SkipLeadMenu({ leadId, businessName, nextHref, fallbackHref, disabled = false, className }: SkipLeadMenuProps) {
  const router = useRouter();
  const noteId = useId();
  const [pending, startTransition] = useTransition();
  const [otherOpen, setOtherOpen] = useState(false);
  const [note, setNote] = useState("");

  function moveOn(href: string | null) {
    if (href) router.push(href);
    else router.refresh();
  }

  function skip(reason: SkipReason | null, skipNote?: string) {
    setOtherOpen(false);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof skipLeadAction>> | null = null;
      try {
        result = await skipLeadAction(leadId, reason, skipNote ?? null);
      } catch {
        result = null;
      }
      if (result?.ok) {
        toast.success(`Skipped ${businessName}`, {
          description: "It waits in Follow-ups › Skipped until you resume it.",
          duration: 8000,
          action: {
            label: "Undo",
            onClick: () => {
              void resumeSkippedLeadAction(leadId).then(
                (resumed) =>
                  resumed.ok ? toast.success(`${businessName} is back in your call queue`) : toast.error(resumed.error.message),
                () => toast.error("Undo failed. Resume the lead from Follow-ups › Skipped."),
              );
            },
          },
        });
        moveOn(nextHref);
      } else {
        toast.error(`${result ? result.error.message : "The skip was not saved."} ${businessName} is skipped for this session only.`);
        router.push(fallbackHref);
      }
    });
  }

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || pending}
            className={cn("h-12 gap-2 px-4 text-base font-bold [&_svg]:size-5", className)}
          >
            <SkipForward aria-hidden />
            {pending ? "Skipping…" : "Skip"}
            <ChevronDown aria-hidden className="size-4!" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Skip {businessName} because…</DropdownMenuLabel>
          {QUICK_REASONS.map((reason) => (
            <DropdownMenuItem key={reason} className="min-h-12" onSelect={() => skip(reason)}>
              {SKIP_REASON_LABELS[reason]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem className="min-h-12" onSelect={() => setOtherOpen(true)}>
            Other reason…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="min-h-12 text-muted-foreground" onSelect={() => skip(null)}>
            Skip without a reason
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {otherOpen ? (
        <Dialog open onOpenChange={(open) => (open ? undefined : setOtherOpen(false))}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Skip {businessName}</DialogTitle>
              <DialogDescription>A short note helps when you come back to it in the Skipped queue.</DialogDescription>
            </DialogHeader>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                skip("OTHER", note);
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor={noteId}>Reason</Label>
                <Textarea
                  id={noteId}
                  value={note}
                  maxLength={MAX_SKIP_NOTE_LENGTH}
                  onChange={(event) => setNote(event.target.value)}
                  rows={3}
                  className="text-base lg:text-sm"
                  autoFocus
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" className="h-12" onClick={() => setOtherOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" className="h-12 font-bold">
                  Skip lead
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

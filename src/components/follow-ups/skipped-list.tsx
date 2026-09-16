"use client";

import { CalendarClock, ChevronDown, PhoneForwarded, UserRoundCog } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useOptimistic, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { DateTime, formatDateTime } from "@/components/common/datetime";
import { StatusBadge } from "@/components/common/status-badge";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { leadFlowHref } from "@/lib/dialer/skip-list";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import { describeSkipReason } from "@/lib/domain/skips";
import { LEAD_STATUSES, STATUS_LABELS, type LeadStatus } from "@/lib/domain/statuses";
import { followUpQuickPicks, tryZonedLocalInputToUtc, utcToZonedLocalInput } from "@/lib/domain/time";
import { reassignLeadAction, setNextFollowUpAction, updateLeadStatusAction } from "@/server/actions/leads";
import { resumeSkippedLeadAction } from "@/server/actions/skipped-leads";
import type { ActionResult } from "@/server/errors";
import type { SkippedLeadRow } from "@/server/services/skipped-leads";

export interface SkippedAgentOption {
  id: string;
  name: string;
}

export interface SkippedLeadListProps {
  rows: SkippedLeadRow[];
  tz: string;
  now: number;
  isAdmin: boolean;
  /** Admin only: active users a lead can be reassigned to. */
  agents: SkippedAgentOption[];
  /** Shown when the last row on the page was just handled. */
  empty: ReactNode;
}

const QUICK_PICKS = [
  { key: "tomorrow9am", label: "Tomorrow 9am" },
  { key: "in3Days", label: "In 3 days" },
  { key: "nextWeek", label: "Next week" },
] as const;

const CLOSED_STATUSES: readonly LeadStatus[] = ["NOT_INTERESTED", "DO_NOT_CONTACT"];

/**
 * The Skipped queue (docs/DEVIATIONS.md D42). Every action takes the lead out of the queue: Resume puts it back in
 * the call queue (and, for its agent, opens it ready to call), and a follow-up, status change or reassignment closes
 * the skip through the existing lead actions. The row leaves at once and comes back if the save fails.
 */
export function SkippedLeadList({ rows, tz, now, isAdmin, agents, empty }: SkippedLeadListProps) {
  const router = useRouter();
  const [visibleRows, hideRow] = useOptimistic(rows, (state: SkippedLeadRow[], id: string) => state.filter((row) => row.skipId !== id));
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [customFor, setCustomFor] = useState<SkippedLeadRow | null>(null);

  function act<T>(row: SkippedLeadRow, action: () => Promise<ActionResult<T>>, success: (data: T) => string, after?: () => void) {
    setPendingId(row.skipId);
    startTransition(async () => {
      hideRow(row.skipId);
      let result: ActionResult<T> | null;
      try {
        result = await action();
      } catch {
        result = null;
      }
      setPendingId(null);
      if (result?.ok) {
        toast.success(success(result.data));
        after?.();
      } else {
        toast.error(result ? result.error.message : `${row.businessName} was not updated. Try again.`);
      }
    });
  }

  function resume(row: SkippedLeadRow) {
    act(
      row,
      () => resumeSkippedLeadAction(row.leadId),
      () => (isAdmin && row.ownerName ? `${row.businessName} is back in ${row.ownerName}'s call queue` : `${row.businessName} is back in your call queue`),
      // An agent resumes to call it now; an admin only hands it back.
      isAdmin ? undefined : () => router.push(leadFlowHref(row.leadId, [], null)),
    );
  }

  function schedule(row: SkippedLeadRow, due: Date) {
    act(
      row,
      () => setNextFollowUpAction(row.leadId, due.toISOString()),
      () => `Follow-up set for ${formatDateTime(due, tz)}: ${row.businessName}`,
    );
  }

  function setStatus(row: SkippedLeadRow, status: LeadStatus) {
    act(row, () => updateLeadStatusAction(row.leadId, status), () => `${row.businessName} moved to ${STATUS_LABELS[status]}`);
  }

  function reassign(row: SkippedLeadRow, agent: SkippedAgentOption) {
    act(row, () => reassignLeadAction(row.leadId, agent.id), () => `${row.businessName} reassigned to ${agent.name}`);
  }

  if (visibleRows.length === 0) return <>{empty}</>;

  return (
    <>
      <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {visibleRows.map((row) => {
          const busy = pendingId === row.skipId;
          const statusChoices = LEAD_STATUSES.filter(
            (status) => status !== row.leadStatus && (isAdmin || row.leadStatus !== "DO_NOT_CONTACT"),
          );
          return (
            <li key={row.skipId} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/leads/${row.leadId}`}
                    className="-my-3 block truncate py-3 text-base font-bold outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {row.businessName}
                  </Link>
                  <p className="truncate text-sm text-muted-foreground tabular-nums">
                    {[row.contactName, formatPhoneDisplay(row.phone)].filter(Boolean).join(" · ")}
                  </p>
                  {isAdmin ? (
                    <p className="truncate text-xs text-muted-foreground">
                      Agent: <span className="text-foreground">{row.ownerName ?? "Unknown"}</span>
                    </p>
                  ) : null}
                </div>
                <StatusBadge status={row.leadStatus} />
              </div>

              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Skipped</dt>
                <dd>
                  <DateTime value={row.skippedAt} tz={tz} now={now} />
                </dd>
                <dt className="text-muted-foreground">Reason</dt>
                <dd className="break-words">{describeSkipReason(row.reason, row.note)}</dd>
                {row.nextFollowUpAt ? (
                  <>
                    <dt className="text-muted-foreground">Follow-up</dt>
                    <dd>
                      <DateTime value={row.nextFollowUpAt} tz={tz} now={now} />
                    </dd>
                  </>
                ) : null}
              </dl>

              <div className="flex flex-wrap gap-2">
                <Button className="h-12 gap-2 px-4 font-bold" disabled={busy} onClick={() => resume(row)}>
                  <PhoneForwarded aria-hidden />
                  {isAdmin ? "Resume" : "Resume calling"}
                  <span className="sr-only"> {row.businessName}</span>
                </Button>

                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="h-12 gap-1.5 px-3 font-semibold" disabled={busy}>
                      <CalendarClock aria-hidden />
                      Follow-up
                      <span className="sr-only"> for {row.businessName}</span>
                      <ChevronDown aria-hidden className="text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-56">
                    {QUICK_PICKS.map((pick) => (
                      <DropdownMenuItem key={pick.key} className="min-h-12" onSelect={() => schedule(row, followUpQuickPicks(tz)[pick.key])}>
                        {pick.label}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="min-h-12" onSelect={() => setCustomFor(row)}>
                      Custom…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="h-12 gap-1.5 px-3 font-semibold" disabled={busy || statusChoices.length === 0}>
                      Status
                      <span className="sr-only"> of {row.businessName}</span>
                      <ChevronDown aria-hidden className="text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-80 min-w-56 overflow-y-auto">
                    {statusChoices.includes("NOT_INTERESTED") ? (
                      <>
                        <DropdownMenuLabel className="text-xs text-muted-foreground">Close the lead</DropdownMenuLabel>
                        <DropdownMenuItem className="min-h-12" onSelect={() => setStatus(row, "NOT_INTERESTED")}>
                          Close as Not Interested
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    ) : null}
                    <DropdownMenuLabel className="text-xs text-muted-foreground">Move to</DropdownMenuLabel>
                    {statusChoices
                      .filter((status) => !CLOSED_STATUSES.includes(status) || isAdmin)
                      .map((status) => (
                        <DropdownMenuItem key={status} className="min-h-12" onSelect={() => setStatus(row, status)}>
                          <StatusBadge status={status} />
                        </DropdownMenuItem>
                      ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                {isAdmin ? (
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="h-12 gap-1.5 px-3 font-semibold" disabled={busy || agents.length === 0}>
                        <UserRoundCog aria-hidden />
                        Reassign
                        <span className="sr-only"> {row.businessName}</span>
                        <ChevronDown aria-hidden className="text-muted-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-80 min-w-56 overflow-y-auto">
                      {agents
                        .filter((agent) => agent.id !== row.assignedTo)
                        .map((agent) => (
                          <DropdownMenuItem key={agent.id} className="min-h-12" onSelect={() => reassign(row, agent)}>
                            {agent.name}
                          </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {customFor ? (
        <CustomFollowUpDialog
          row={customFor}
          tz={tz}
          onClose={() => setCustomFor(null)}
          onSubmit={(due) => {
            const row = customFor;
            setCustomFor(null);
            schedule(row, due);
          }}
        />
      ) : null}
    </>
  );
}

function CustomFollowUpDialog({
  row,
  tz,
  onClose,
  onSubmit,
}: {
  row: SkippedLeadRow;
  tz: string;
  onClose(): void;
  onSubmit(due: Date): void;
}) {
  const inputId = useId();
  const [value, setValue] = useState(() => utcToZonedLocalInput(followUpQuickPicks(tz).tomorrow9am, tz));
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const due = tryZonedLocalInputToUtc(value, tz);
    if (!due || due.getTime() <= Date.now()) {
      setError("Pick a date and time in the future.");
      return;
    }
    onSubmit(due);
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule a follow-up</DialogTitle>
          <DialogDescription>
            {row.businessName}. Times are in {tz.replace(/_/g, " ")}.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Label htmlFor={inputId}>Date and time</Label>
          <Input
            id={inputId}
            type="datetime-local"
            value={value}
            required
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={error ? true : undefined}
            className="h-12 text-base lg:text-sm"
          />
          <p aria-live="polite" className="min-h-4 text-xs text-destructive">
            {error ?? ""}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-12 px-5" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" className="h-12 px-5 font-bold">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

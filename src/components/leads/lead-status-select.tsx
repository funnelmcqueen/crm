"use client";

import { useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/common/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LEAD_STATUSES, STATUS_LABELS, isLeadStatus, type LeadStatus } from "@/lib/domain/statuses";
import { updateLeadStatusAction } from "@/server/actions/leads";

export interface LeadStatusSelectProps {
  leadId: string;
  status: LeadStatus;
  isAdmin: boolean;
}

export function LeadStatusSelect({ leadId, status, isAdmin }: LeadStatusSelectProps) {
  const [optimistic, setOptimistic] = useOptimistic(status);
  const [pending, startTransition] = useTransition();
  const [confirmDnc, setConfirmDnc] = useState(false);
  // DEVIATIONS D12: only an admin moves a lead away from DO_NOT_CONTACT.
  const locked = !isAdmin && status === "DO_NOT_CONTACT";

  function save(next: LeadStatus) {
    startTransition(async () => {
      setOptimistic(next);
      const result = await updateLeadStatusAction(leadId, next);
      if (result.ok) toast.success(`Status set to ${STATUS_LABELS[result.data.status]}`);
      else toast.error(result.error.message);
    });
  }

  function onChange(value: string) {
    if (!isLeadStatus(value) || value === optimistic) return;
    if (value === "DO_NOT_CONTACT" && !isAdmin) {
      setConfirmDnc(true);
      return;
    }
    save(value);
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="lead-status" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Status
      </Label>
      <Select value={optimistic} onValueChange={onChange} disabled={locked || pending}>
        <SelectTrigger
          id="lead-status"
          aria-describedby={locked ? "lead-status-locked" : undefined}
          className="w-full px-3 data-[size=default]:h-12"
        >
          <SelectValue>
            <StatusBadge status={optimistic} />
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start" className="max-h-80">
          {LEAD_STATUSES.map((value) => (
            <SelectItem key={value} value={value} className="min-h-11">
              {STATUS_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {locked ? (
        <p id="lead-status-locked" className="text-xs text-muted-foreground">
          Only an admin can reopen this lead
        </p>
      ) : null}

      <AlertDialog open={confirmDnc} onOpenChange={setConfirmDnc}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark as Do Not Contact?</AlertDialogTitle>
            <AlertDialogDescription>
              Calling will be blocked for this lead. Only an admin can reopen it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-12">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" className="h-12" onClick={() => save("DO_NOT_CONTACT")}>
              Do Not Contact
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

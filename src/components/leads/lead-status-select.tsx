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
import { LEAD_STATUSES, isLeadStatus, type LeadStatus } from "@/lib/domain/statuses";
import { useTranslations } from "@/components/i18n/locale-provider";
import { updateLeadStatusAction } from "@/server/actions/leads";

export interface LeadStatusSelectProps {
  leadId: string;
  status: LeadStatus;
  isAdmin: boolean;
}

export function LeadStatusSelect({ leadId, status, isAdmin }: LeadStatusSelectProps) {
  const t = useTranslations("workspace");
  const [optimistic, setOptimistic] = useOptimistic(status);
  const [pending, startTransition] = useTransition();
  const [confirmDnc, setConfirmDnc] = useState(false);
  // DEVIATIONS D12: only an admin moves a lead away from DO_NOT_CONTACT.
  const locked = !isAdmin && status === "DO_NOT_CONTACT";

  function save(next: LeadStatus) {
    startTransition(async () => {
      setOptimistic(next);
      const result = await updateLeadStatusAction(leadId, next);
      if (result.ok) toast.success(t.statusSetTo.replace("{status}", t.statuses[result.data.status]));
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
        {t.status}
      </Label>
      <Select value={optimistic} onValueChange={onChange} disabled={locked || pending}>
        <SelectTrigger
          id="lead-status"
          aria-describedby={locked ? "lead-status-locked" : undefined}
          className="h-auto min-h-12 w-full px-3 py-2 text-left whitespace-normal *:data-[slot=select-value]:line-clamp-none"
        >
          <SelectValue>
            <StatusBadge status={optimistic} label={t.statuses[optimistic]} className="h-auto min-h-6 whitespace-normal" />
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start" className="max-h-80">
          {LEAD_STATUSES.map((value) => (
            <SelectItem key={value} value={value} className="min-h-12">
              {t.statuses[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {locked ? (
        <p id="lead-status-locked" className="text-xs text-muted-foreground">
          {t.onlyAdminReopen}
        </p>
      ) : null}

      <AlertDialog open={confirmDnc} onOpenChange={setConfirmDnc}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.markDoNotContact}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.doNotContactWarning}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-12">{t.cancel}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" className="h-12" onClick={() => save("DO_NOT_CONTACT")}>
              {t.statuses.DO_NOT_CONTACT}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

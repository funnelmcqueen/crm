"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  deleteLeadAction,
  reassignLeadAction,
  updateLeadDetailsAction,
  type LeadDetailsForm,
} from "@/server/actions/leads";

const UNASSIGNED = "__unassigned";

export interface AdminLeadPanelProps {
  leadId: string;
  businessName: string;
  assignedTo: { id: string; name: string; active: boolean } | null;
  /** Active users only: reassign_leads accepts nobody else. */
  agents: Array<{ id: string; name: string }>;
  details: LeadDetailsForm;
}

export function AdminLeadPanel({ leadId, businessName, assignedTo, agents, details }: AdminLeadPanelProps) {
  const current = assignedTo?.id ?? UNASSIGNED;
  const [target, setTarget] = useState(current);
  const [syncedCurrent, setSyncedCurrent] = useState(current);
  if (current !== syncedCurrent) {
    setSyncedCurrent(current);
    setTarget(current);
  }
  const [confirmReassign, setConfirmReassign] = useState(false);
  const [reassigning, startReassign] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const targetName = target === UNASSIGNED ? null : (agents.find((a) => a.id === target)?.name ?? "this agent");

  function reassign() {
    startReassign(async () => {
      const result = await reassignLeadAction(leadId, target === UNASSIGNED ? null : target);
      if (result.ok) {
        toast.success(targetName ? `Reassigned to ${targetName}` : "Lead unassigned");
        setConfirmReassign(false);
      } else {
        toast.error(result.error.message);
      }
    });
  }

  function remove() {
    startDelete(async () => {
      // Redirects to /leads on success.
      const result = await deleteLeadAction(leadId);
      if (!result.ok) {
        toast.error(result.error.message);
        setDeleteOpen(false);
      }
    });
  }

  return (
    <section aria-labelledby="admin-panel-title" className="flex flex-col gap-4 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="admin-panel-title" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Admin
        </h2>
        <EditLeadDialog leadId={leadId} details={details} />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Assigned agent</span>
        <p className="font-bold">
          {assignedTo ? (
            <>
              {assignedTo.name}
              {assignedTo.active ? null : <span className="ml-2 text-xs font-semibold text-destructive">Disabled</span>}
            </>
          ) : (
            <span className="text-muted-foreground">Unassigned</span>
          )}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="reassign-target" className="text-xs text-muted-foreground">
          Reassign to
        </Label>
        <div className="flex gap-2">
          <Select value={target} onValueChange={setTarget} disabled={reassigning}>
            <SelectTrigger id="reassign-target" className="min-w-0 flex-1 px-3 data-[size=default]:h-12">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start" className="max-h-80">
              <SelectItem value={UNASSIGNED} className="min-h-12">
                Unassigned
              </SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id} className="min-h-12">
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <AlertDialog open={confirmReassign} onOpenChange={setConfirmReassign}>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="h-12 px-4" disabled={target === current || reassigning}>
                Reassign
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{targetName ? `Reassign to ${targetName}?` : "Unassign this lead?"}</AlertDialogTitle>
                <AlertDialogDescription>
                  {targetName
                    ? `${businessName} moves to ${targetName} with its call history and open follow-ups.`
                    : `${businessName} will have no agent.`}{" "}
                  {assignedTo ? "The current agent loses access." : ""}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="h-12" disabled={reassigning}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  className="h-12 font-bold"
                  disabled={reassigning}
                  onClick={(event) => {
                    event.preventDefault();
                    reassign();
                  }}
                >
                  {reassigning ? "Reassigning…" : "Reassign"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" className="h-12 gap-2">
            <Trash2 aria-hidden />
            Delete lead
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete lead permanently?</AlertDialogTitle>
            <AlertDialogDescription>This also deletes its call history and follow-ups.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-12" disabled={deleting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="h-12 font-bold"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                remove();
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

const FIELDS: ReadonlyArray<{
  key: keyof LeadDetailsForm;
  label: string;
  type?: string;
  inputMode?: "text" | "tel" | "email" | "url";
  autoComplete?: string;
  required?: boolean;
  wide?: boolean;
}> = [
  { key: "businessName", label: "Business name", required: true, wide: true },
  { key: "contactName", label: "Contact name" },
  { key: "phone", label: "Phone", type: "tel", inputMode: "tel", required: true },
  { key: "email", label: "Email", type: "email", inputMode: "email" },
  { key: "website", label: "Website", inputMode: "url" },
  { key: "address", label: "Address", wide: true },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "country", label: "Country" },
  { key: "source", label: "Source" },
];

function EditLeadDialog({ leadId, details }: { leadId: string; details: LeadDetailsForm }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<LeadDetailsForm>(details);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (next) {
      setForm(details);
      setError(null);
    }
    setOpen(next);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await updateLeadDetailsAction(leadId, form);
      if (result.ok) {
        toast.success("Lead details saved");
        setOpen(false);
      } else {
        setError(result.error.message);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="h-12 gap-2 px-3">
          <Pencil aria-hidden />
          Edit details
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Edit lead details</DialogTitle>
            <DialogDescription>Phone numbers are saved in international format.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {FIELDS.map((field) => {
              const id = `edit-lead-${field.key}`;
              return (
                <div key={field.key} className={field.wide ? "flex flex-col gap-1.5 sm:col-span-2" : "flex flex-col gap-1.5"}>
                  <Label htmlFor={id}>{field.label}</Label>
                  <Input
                    id={id}
                    type={field.type ?? "text"}
                    inputMode={field.inputMode}
                    required={field.required}
                    value={form[field.key]}
                    onChange={(event) => setForm((prev) => ({ ...prev, [field.key]: event.target.value }))}
                    className="h-12 text-base md:text-sm"
                  />
                </div>
              );
            })}
          </div>
          <p role="alert" aria-live="polite" className="min-h-5 text-sm font-semibold text-destructive">
            {error ?? ""}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-12" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" className="h-12 font-bold" disabled={pending}>
              {pending ? "Saving…" : "Save details"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

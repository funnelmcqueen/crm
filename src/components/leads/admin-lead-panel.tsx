"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import { useLocale } from "@/components/i18n/locale-provider";
import { getAppErrorMessage } from "@/lib/i18n/app-error-message";
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
  const { locale } = useLocale();
  const de = locale === "de";
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

  const targetName = target === UNASSIGNED ? null : (agents.find((a) => a.id === target)?.name ?? (de ? "diesem Agenten" : "this agent"));

  function reassign() {
    startReassign(async () => {
      const result = await reassignLeadAction(leadId, target === UNASSIGNED ? null : target);
      if (result.ok) {
        toast.success(targetName ? (de ? `Neu zugewiesen an ${targetName}` : `Reassigned to ${targetName}`) : (de ? "Lead nicht zugewiesen" : "Lead unassigned"));
        setConfirmReassign(false);
      } else {
        toast.error(getAppErrorMessage(result.error.code, locale, result.error.message));
      }
    });
  }

  function remove() {
    startDelete(async () => {
      // Redirects to /leads on success.
      const result = await deleteLeadAction(leadId);
      if (!result.ok) {
        toast.error(getAppErrorMessage(result.error.code, locale, result.error.message));
        setDeleteOpen(false);
      }
    });
  }

  return (
    <section aria-labelledby="admin-panel-title" className="flex flex-col gap-4 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="admin-panel-title" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {de ? "Administration" : "Admin"}
        </h2>
        <EditLeadDialog leadId={leadId} details={details} />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{de ? "Zugewiesener Agent" : "Assigned agent"}</span>
        <p className="font-bold">
          {assignedTo ? (
            <>
              {assignedTo.name}
              {assignedTo.active ? null : <span className="ml-2 text-xs font-semibold text-destructive">{de ? "Deaktiviert" : "Disabled"}</span>}
            </>
          ) : (
            <span className="text-muted-foreground">{de ? "Nicht zugewiesen" : "Unassigned"}</span>
          )}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="reassign-target" className="text-xs text-muted-foreground">
          {de ? "Neu zuweisen an" : "Reassign to"}
        </Label>
        <div className="flex gap-2">
          <Select value={target} onValueChange={setTarget} disabled={reassigning}>
            <SelectTrigger id="reassign-target" className="min-w-0 flex-1 px-3 data-[size=default]:h-12">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start" className="max-h-80">
              <SelectItem value={UNASSIGNED} className="min-h-12">
                {de ? "Nicht zugewiesen" : "Unassigned"}
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
                {de ? "Neu zuweisen" : "Reassign"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{targetName ? (de ? `An ${targetName} neu zuweisen?` : `Reassign to ${targetName}?`) : (de ? "Zuweisung dieses Leads aufheben?" : "Unassign this lead?")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {targetName
                    ? (de ? `${businessName} wird mit Anrufverlauf und offenen Wiedervorlagen an ${targetName} übertragen.` : `${businessName} moves to ${targetName} with its call history and open follow-ups.`)
                    : (de ? `${businessName} hat danach keinen zugewiesenen Agenten.` : `${businessName} will have no agent.`)}{" "}
                  {assignedTo ? (de ? "Der bisherige Agent verliert den Zugriff." : "The current agent loses access.") : ""}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="h-12" disabled={reassigning}>
                  {de ? "Abbrechen" : "Cancel"}
                </AlertDialogCancel>
                <AlertDialogAction
                  className="h-12 font-bold"
                  disabled={reassigning}
                  onClick={(event) => {
                    event.preventDefault();
                    reassign();
                  }}
                >
                  {reassigning ? (de ? "Wird neu zugewiesen…" : "Reassigning…") : (de ? "Neu zuweisen" : "Reassign")}
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
            {de ? "Lead löschen" : "Delete lead"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{de ? "Lead dauerhaft löschen?" : "Delete lead permanently?"}</AlertDialogTitle>
            <AlertDialogDescription>{de ? "Dadurch werden auch Anrufverlauf und Wiedervorlagen gelöscht." : "This also deletes its call history and follow-ups."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-12" disabled={deleting}>
              {de ? "Abbrechen" : "Cancel"}
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
              {deleting ? (de ? "Wird gelöscht…" : "Deleting…") : (de ? "Löschen" : "Delete")}
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
  const { locale } = useLocale();
  const de = locale === "de";
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
        toast.success(de ? "Lead-Angaben gespeichert" : "Lead details saved");
        setOpen(false);
      } else {
        setError(getAppErrorMessage(result.error.code, locale, result.error.message));
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="h-12 gap-2 px-3">
          <Pencil aria-hidden />
          {de ? "Angaben bearbeiten" : "Edit details"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{de ? "Lead-Angaben bearbeiten" : "Edit lead details"}</DialogTitle>
            <DialogDescription>{de ? "Telefonnummern werden im internationalen Format gespeichert." : "Phone numbers are saved in international format."}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {FIELDS.map((field) => {
              const id = `edit-lead-${field.key}`;
              return (
                <div key={field.key} className={field.wide ? "flex flex-col gap-1.5 sm:col-span-2" : "flex flex-col gap-1.5"}>
                  <Label htmlFor={id}>{de ? ({ businessName: "Firmenname", contactName: "Kontaktname", phone: "Telefon", email: "E-Mail", website: "Website", address: "Adresse", city: "Stadt", state: "Bundesland", country: "Land", source: "Quelle" } as Record<keyof LeadDetailsForm, string>)[field.key] : field.label}</Label>
                  <Input
                    id={id}
                    type={field.type ?? "text"}
                    inputMode={field.inputMode}
                    required={field.required}
                    value={form[field.key]}
                    onChange={(event) => setForm((prev) => ({ ...prev, [field.key]: event.target.value }))}
                    className="h-12 text-base lg:text-sm"
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
              {de ? "Abbrechen" : "Cancel"}
            </Button>
            <Button type="submit" className="h-12 font-bold" disabled={pending}>
              {pending ? (de ? "Wird gespeichert…" : "Saving…") : (de ? "Angaben speichern" : "Save details")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateLeadNotesAction } from "@/server/actions/leads";

const MAX_NOTES = 10_000;

export interface LeadNotesFormProps {
  leadId: string;
  notes: string | null;
}

export function LeadNotesForm({ leadId, notes }: LeadNotesFormProps) {
  const [value, setValue] = useState(notes ?? "");
  const [saved, setSaved] = useState(notes ?? "");
  const [syncedNotes, setSyncedNotes] = useState(notes);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // A newer server value (another tab, an admin edit) replaces the text only when nothing is unsaved.
  if (notes !== syncedNotes) {
    setSyncedNotes(notes);
    if (value.trim() === saved.trim()) setValue(notes ?? "");
    setSaved(notes ?? "");
  }

  const dirty = value.trim() !== saved.trim();

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!dirty || pending) return;
    const draft = value;
    setError(null);
    startTransition(async () => {
      const result = await updateLeadNotesAction(leadId, draft);
      if (result.ok) {
        const stored = result.data.notes ?? "";
        setSaved(stored);
        setValue((current) => (current === draft ? stored : current));
        toast.success("Notes saved");
      } else {
        setError(result.error.message);
      }
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Label htmlFor="lead-notes" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Notes
      </Label>
      <Textarea
        id="lead-notes"
        value={value}
        maxLength={MAX_NOTES}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Gatekeeper name, best time to call, objections…"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "lead-notes-error" : undefined}
        className="min-h-32 text-base lg:text-sm"
      />
      <div className="flex items-center justify-between gap-3">
        <p id="lead-notes-error" aria-live="polite" className="text-xs text-destructive">
          {error ?? ""}
        </p>
        <div className="flex items-center gap-3">
          {dirty && !pending ? <span className="text-xs text-muted-foreground">Unsaved</span> : null}
          <Button type="submit" disabled={!dirty || pending} className="h-12 min-w-24 font-bold">
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </form>
  );
}

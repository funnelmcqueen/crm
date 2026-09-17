"use client";

import { useEffect, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { useUnsavedNotes } from "@/components/common/use-unsaved-notes";
import { draftKey, leadDraftSchema, readDraft, removeDraft, writeDraft } from "@/lib/dialer/workspace-drafts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateLeadNotesAction } from "@/server/actions/leads";

const MAX_NOTES = 10_000;

export interface LeadNotesFormProps {
  userId: string;
  leadId: string;
  notes: string | null;
}

export function LeadNotesForm({ userId, leadId, notes }: LeadNotesFormProps) {
  const storageKey = draftKey(userId, "lead", leadId);
  const [value, setValue] = useState(notes ?? "");
  const [saved, setSaved] = useState(notes ?? "");
  const [syncedNotes, setSyncedNotes] = useState(notes);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  useEffect(() => {
    let canceled = false;
    // Restore after hydration; the server still decides whether this lead is accessible.
    queueMicrotask(() => {
      const draft = readDraft(storageKey, leadDraftSchema);
      if (!canceled && draft !== null) {
        setValue(draft);
        setDraftNotice("Unsaved draft restored. Save to keep it on this lead.");
      }
    });
    return () => { canceled = true; };
  }, [storageKey]);

  // A newer server value (another tab, an admin edit) replaces the text only when nothing is unsaved.
  if (notes !== syncedNotes) {
    setSyncedNotes(notes);
    if (value.trim() === saved.trim()) setValue(notes ?? "");
    setSaved(notes ?? "");
  }

  const dirty = value.trim() !== saved.trim();
  useUnsavedNotes(dirty);

  function changeValue(next: string) {
    setValue(next);
    if (next.trim() === saved.trim()) {
      removeDraft(storageKey);
      setDraftNotice(null);
    } else {
      setDraftNotice(writeDraft(storageKey, next)
        ? "Draft kept in this tab. Save to keep it on this lead."
        : "Draft recovery is unavailable. Save your notes before leaving.");
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!dirty || pending) return;
    const draft = value;
    setError(null);
    startTransition(async () => {
      try {
        const result = await updateLeadNotesAction(leadId, draft);
        if (result.ok) {
          const stored = result.data.notes ?? "";
          setSaved(stored);
          setValue(stored);
          removeDraft(storageKey);
          setDraftNotice(null);
          toast.success("Notes saved");
        } else {
          setError(result.error.message);
        }
      } catch {
        setError("Couldn't save your notes. Check your connection and try again. Your draft is still here.");
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
        onChange={(event) => changeValue(event.target.value)}
        disabled={pending}
        onKeyDown={onKeyDown}
        placeholder="Gatekeeper name, best time to call, objections…"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "lead-notes-error" : undefined}
        className="min-h-32 text-base lg:text-sm"
      />
      <p role="status" className="text-xs text-muted-foreground">{draftNotice}</p>
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

"use client";

import { useId, useState } from "react";
import { formatDateTime } from "@/components/common/datetime";
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
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_BULK_NOTE_LENGTH, leadCount } from "@/lib/domain/bulk-leads";
import { followUpQuickPicks, tryZonedLocalInputToUtc, utcToZonedLocalInput } from "@/lib/domain/time";
import { MAX_SOURCE_LENGTH } from "../list-params";

type QuickPick = "tomorrow9am" | "in3Days" | "nextWeek";

const QUICK_PICKS: ReadonlyArray<{ key: QuickPick; label: string }> = [
  { key: "tomorrow9am", label: "Tomorrow 9am" },
  { key: "in3Days", label: "In 3 days" },
  { key: "nextWeek", label: "Next week" },
];

export interface BulkFollowUpDialogProps {
  count: number;
  tz: string;
  now: number;
  onClose(): void;
  /** `note` undefined keeps the notes of follow-ups that are only rescheduled. */
  onSubmit(due: Date, note: string | undefined): void;
}

/** Schedule or reschedule a follow-up on every selected lead: pick a time, optionally a note, then confirm. */
export function BulkFollowUpDialog({ count, tz, now, onClose, onSubmit }: BulkFollowUpDialogProps) {
  const ids = useId();
  const [pick, setPick] = useState<QuickPick | "custom">("tomorrow9am");
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const due = pick === "custom" ? tryZonedLocalInputToUtc(custom, tz) : followUpQuickPicks(tz)[pick];
    if (!due) {
      setError("Pick a date and time.");
      return;
    }
    if (due.getTime() <= Date.now()) {
      setError("Pick a time in the future.");
      return;
    }
    onSubmit(due, note.trim() === "" ? undefined : note.trim());
  }

  const preview = pick === "custom" ? tryZonedLocalInputToUtc(custom, tz) : followUpQuickPicks(tz, now)[pick];

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Follow-up for {leadCount(count)}</DialogTitle>
          <DialogDescription>
            Each lead&rsquo;s next open follow-up moves to this time, or a new one is created. Times are in {tz.replace(/_/g, " ")}.
          </DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label="When" className="grid grid-cols-2 gap-2">
          {QUICK_PICKS.map((option) => (
            <Button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={pick === option.key}
              variant={pick === option.key ? "secondary" : "outline"}
              className="h-12 aria-checked:border-primary"
              onClick={() => {
                setPick(option.key);
                setError(null);
              }}
            >
              {option.label}
            </Button>
          ))}
          <Button
            type="button"
            role="radio"
            aria-checked={pick === "custom"}
            variant={pick === "custom" ? "secondary" : "outline"}
            className="h-12 aria-checked:border-primary"
            onClick={() => setPick("custom")}
          >
            Custom
          </Button>
        </div>

        {pick === "custom" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-custom`} className="text-xs text-muted-foreground">
              Date and time
            </Label>
            <Input
              id={`${ids}-custom`}
              type="datetime-local"
              value={custom}
              min={utcToZonedLocalInput(now, tz)}
              onChange={(event) => {
                setCustom(event.target.value);
                setError(null);
              }}
              className="h-12 text-base lg:text-sm"
            />
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-note`} className="text-xs text-muted-foreground">
            Note (optional, replaces existing notes)
          </Label>
          <Input
            id={`${ids}-note`}
            value={note}
            maxLength={MAX_BULK_NOTE_LENGTH}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What to follow up on"
            className="h-12 text-base lg:text-sm"
          />
        </div>

        <p aria-live="polite" className="text-sm">
          {error ? (
            <span className="font-semibold text-destructive">{error}</span>
          ) : preview ? (
            <span className="text-muted-foreground">Due {formatDateTime(preview, tz)}</span>
          ) : null}
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" className="h-12" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" className="h-12 font-bold" onClick={submit}>
            Set follow-up on {leadCount(count)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface BulkSourceDialogProps {
  count: number;
  sources: string[];
  onClose(): void;
  onSubmit(source: string | null): void;
}

export function BulkSourceDialog({ count, sources, onClose, onSubmit }: BulkSourceDialogProps) {
  const ids = useId();
  const [value, setValue] = useState("");
  const trimmed = value.trim();

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change the source of {leadCount(count)}</DialogTitle>
          <DialogDescription>Type a new source or pick one already in use. Clearing removes the source from these leads.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== "") onSubmit(trimmed);
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-source`}>Source</Label>
            <Input
              id={`${ids}-source`}
              list={`${ids}-sources`}
              value={value}
              maxLength={MAX_SOURCE_LENGTH}
              onChange={(event) => setValue(event.target.value)}
              className="h-12 text-base lg:text-sm"
              autoComplete="off"
            />
            <datalist id={`${ids}-sources`}>
              {sources.map((source) => (
                <option key={source} value={source} />
              ))}
            </datalist>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="ghost" className="h-12" onClick={() => onSubmit(null)}>
              Clear source
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" className="h-12" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" className="h-12 font-bold" disabled={trimmed === ""}>
                Set source
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface BulkConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onClose(): void;
  onConfirm(): void;
}

export function BulkConfirmDialog({ title, description, confirmLabel, destructive = false, onClose, onConfirm }: BulkConfirmDialogProps) {
  return (
    <AlertDialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-12">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            className="h-12 font-bold"
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

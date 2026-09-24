"use client";

import { useId, useState } from "react";
import { useTranslations } from "@/components/i18n/locale-provider";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { BUSINESS_TYPES, BUSINESS_TYPE_LABELS, isBusinessType, type BusinessType } from "@/lib/domain/business-type";
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
  const t = useTranslations("workspace").bulkDialogs;
  const ids = useId();
  const [pick, setPick] = useState<QuickPick | "custom">("tomorrow9am");
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const due = pick === "custom" ? tryZonedLocalInputToUtc(custom, tz) : followUpQuickPicks(tz)[pick];
    if (!due) {
      setError(t.pickDate);
      return;
    }
    if (due.getTime() <= Date.now()) {
      setError(t.pickFuture);
      return;
    }
    onSubmit(due, note.trim() === "" ? undefined : note.trim());
  }

  const preview = pick === "custom" ? tryZonedLocalInputToUtc(custom, tz) : followUpQuickPicks(tz, now)[pick];

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t.followUpFor.replace("{count}", leadCount(count))}</DialogTitle>
          <DialogDescription>
            {t.followUpDescription.replace("{zone}", tz.replace(/_/g, " "))}
          </DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label={t.when} className="grid grid-cols-2 gap-2">
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
              {{ tomorrow9am: t.tomorrow, in3Days: t.in3Days, nextWeek: t.nextWeek }[option.key]}
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
            {t.custom}
          </Button>
        </div>

        {pick === "custom" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-custom`} className="text-xs text-muted-foreground">
              {t.dateTime}
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
            {t.noteOptional}
          </Label>
          <Input
            id={`${ids}-note`}
            value={note}
            maxLength={MAX_BULK_NOTE_LENGTH}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t.notePlaceholder}
            className="h-12 text-base lg:text-sm"
          />
        </div>

        <p aria-live="polite" className="text-sm">
          {error ? (
            <span className="font-semibold text-destructive">{error}</span>
          ) : preview ? (
            <span className="text-muted-foreground">{t.due} {formatDateTime(preview, tz)}</span>
          ) : null}
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" className="h-12" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button type="button" className="h-12 font-bold" onClick={submit}>
            {t.setFollowUpOn.replace("{count}", leadCount(count))}
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
  const t = useTranslations("workspace").bulkDialogs;
  const ids = useId();
  const [value, setValue] = useState("");
  const trimmed = value.trim();

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t.changeSourceOf.replace("{count}", leadCount(count))}</DialogTitle>
          <DialogDescription>{t.sourceDescription}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== "") onSubmit(trimmed);
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-source`}>{t.source}</Label>
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
              {t.clearSource}
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" className="h-12" onClick={onClose}>
                {t.cancel}
              </Button>
              <Button type="submit" className="h-12 font-bold" disabled={trimmed === ""}>
                {t.setSource}
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
  const t = useTranslations("workspace").bulkDialogs;
  return (
    <AlertDialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-12">{t.cancel}</AlertDialogCancel>
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

const GUESS_FROM_NAME = "guess";

export interface BulkBusinessTypeDialogProps {
  count: number;
  onClose(): void;
  onSubmit(type: BusinessType | null): void;
}

/** Pick one of the eight types, or go back to guessing from the name (clears the stored type). */
export function BulkBusinessTypeDialog({ count, onClose, onSubmit }: BulkBusinessTypeDialogProps) {
  const t = useTranslations("workspace").bulkDialogs;
  const ids = useId();
  const [value, setValue] = useState("");
  const options = [...BUSINESS_TYPES, GUESS_FROM_NAME];

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t.businessTypeOf.replace("{count}", leadCount(count))}</DialogTitle>
          <DialogDescription>{t.businessTypeDescription}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (value === GUESS_FROM_NAME) onSubmit(null);
            else if (isBusinessType(value)) onSubmit(value);
          }}
        >
          <RadioGroup value={value} onValueChange={setValue} aria-label={t.businessType} className="grid gap-2 sm:grid-cols-2">
            {options.map((option) => {
              const id = `${ids}-${option}`;
              return (
                <Label
                  key={option}
                  htmlFor={id}
                  className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border p-3 font-normal has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/10"
                >
                  <RadioGroupItem id={id} value={option} />
                  {isBusinessType(option) ? BUSINESS_TYPE_LABELS[option] : t.guessFromName}
                </Label>
              );
            })}
          </RadioGroup>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-12" onClick={onClose}>
                {t.cancel}
            </Button>
            <Button type="submit" className="min-h-12" disabled={value === ""}>
              {t.setBusinessType}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

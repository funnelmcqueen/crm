"use client";

import { Check } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { confirmUnsavedNotes } from "@/components/common/use-unsaved-notes";
import { draftKey, outcomeDraftSchema, readDraft, removeDraft, writeDraft } from "@/lib/dialer/workspace-drafts";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  EMPTY_OUTCOME_FORM,
  FOLLOW_UP_PICKS,
  MAX_CALL_NOTES,
  MAX_FOLLOW_UP_NOTE,
  buildLogCallPayload,
  outcomeFromShortcutKey,
  outcomeSheetEnterAction,
  resolveFollowUpAt,
  type OutcomeFormValues,
} from "@/lib/dialer/outcome-form";
import type { WrapUp } from "@/lib/dialer/state";
import { CALL_OUTCOME_OPTIONS, type CallOutcome } from "@/lib/domain/outcomes";
import { isValidTimeZone } from "@/lib/domain/time";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { formatDate } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
import { cheerOutcome } from "@/components/pep/pep-toast";
import { logCallAction } from "@/server/actions/calls";

export interface OutcomeSheetProps {
  userId: string;
  wrapUp: WrapUp;
  timezone: string;
  /** After a successful save. `goNext` is true for Save & Next. */
  onSaved(goNext: boolean): void;
  /** The agent confirmed closing without logging. */
  onDiscard(): void;
}

export function OutcomeSheet({ userId, wrapUp, timezone, onSaved, onDiscard }: OutcomeSheetProps) {
  const t = useTranslations("workspace");
  const { locale } = useLocale();
  const storageKey = draftKey(userId, "outcome", wrapUp.callId ?? wrapUp.clientRequestId ?? "unknown");
  const formId = useId();
  const tz = isValidTimeZone(timezone) ? timezone : "UTC";
  const [values, setValues] = useState<OutcomeFormValues>(() => readDraft(storageKey, outcomeDraftSchema) ?? EMPTY_OUTCOME_FORM);
  const valuesRef = useRef(values);
  const [notesOpen, setNotesOpen] = useState(values.notes.length > 0);
  const [draftUnavailable, setDraftUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const savingRef = useRef(false);
  const saveNextRef = useRef<HTMLButtonElement>(null);
  const firstOutcomeRef = useRef<HTMLButtonElement>(null);

  // The agent's own choice wins; until then the end reason (or server status) suggests one.
  const outcome: CallOutcome | null = values.outcome ?? wrapUp.preselectedOutcome;
  const update = (patch: Partial<OutcomeFormValues>) => {
    const next = { ...valuesRef.current, ...patch };
    valuesRef.current = next;
    setValues(next);
    setDraftUnavailable(!writeDraft(storageKey, next));
    setError(null);
  };

  const followUpPreview =
    outcome === "FOLLOW_UP" && values.followUpPick !== null
      ? resolveFollowUpAt(values.followUpPick, values.customFollowUp, tz, new Date())
      : null;

  async function save(goNext: boolean) {
    if (savingRef.current) return;
    if (goNext && !confirmUnsavedNotes()) return;
    const built = buildLogCallPayload(
      { ...values, outcome },
      {
        mode: wrapUp.mode,
        leadId: wrapUp.leadId,
        callId: wrapUp.callId,
        clientRequestId: wrapUp.clientRequestId,
        timezone: tz,
        now: new Date(),
      },
    );
    if (!built.ok) {
      setError(built.error);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await logCallAction(built.payload);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      removeDraft(storageKey);
      // Only a real lead gets named: an unknown inbound caller's label is their phone number.
      cheerOutcome({ outcome: built.payload.outcome, business: wrapUp.leadId ? wrapUp.label : null, callId: result.data.callId });
      onSaved(goNext);
    } catch {
      setError(t.saveError);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    const typing = target.closest("input, textarea, select, [contenteditable='true']") !== null;
    if (!typing) {
      const shortcut = outcomeFromShortcutKey(event.key);
      if (shortcut) {
        event.preventDefault();
        update({ outcome: shortcut });
        // Focus follows the choice, so the Enter that usually comes next saves exactly this outcome.
        event.currentTarget.querySelector<HTMLButtonElement>(`button[data-outcome="${shortcut}"]`)?.focus();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      const button = target.closest("button");
      const action = outcomeSheetEnterAction(
        {
          tagName: target.tagName,
          isButton: button !== null,
          outcome: button?.getAttribute("data-outcome") ?? null,
          isSaveNext: button?.hasAttribute("data-save-next") ?? false,
        },
        outcome,
      );
      if (action.kind === "ignore") return;
      event.preventDefault();
      if (action.kind === "select") update({ outcome: action.outcome });
      else void save(true);
    }
  }

  const endLabel = wrapUp.mode === "TEL" ? t.callEnds.phone : t.callEnds[wrapUp.endReason];

  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open && !saving) setConfirmOpen(true);
        }}
      >
        <SheetContent
          side="bottom"
          aria-describedby={`${formId}-description`}
          className="max-h-[92dvh] gap-0 rounded-t-2xl p-0"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            if (!saving) setConfirmOpen(true);
          }}
          onInteractOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (wrapUp.preselectedOutcome ? saveNextRef.current : firstOutcomeRef.current)?.focus();
          }}
          onKeyDown={onKeyDown}
        >
          <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
            <SheetHeader className="px-5 pt-5 pb-3">
              <SheetTitle className="text-xl font-extrabold">{t.logCall}</SheetTitle>
              <SheetDescription id={`${formId}-description`} className="truncate">
                <span className="font-semibold text-foreground">{wrapUp.label}</span> · {endLabel}
              </SheetDescription>
            </SheetHeader>

            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pb-4">
              <p className="text-sm text-muted-foreground">{t.outcomeIntro}</p>
              <p className="hidden text-xs text-muted-foreground md:block">{t.outcomeShortcut}</p>
              <div role="radiogroup" aria-label={t.outcome} className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {CALL_OUTCOME_OPTIONS.map((option, index) => {
                  const selected = outcome === option.value;
                  return (
                    <button
                      key={option.value}
                      ref={index === 0 ? firstOutcomeRef : undefined}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-outcome={option.value}
                      disabled={saving}
                      onClick={() => update({ outcome: option.value })}
                      className={cn(
                        "relative flex min-h-14 items-center justify-center gap-2 rounded-xl border px-3 text-base font-bold outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-popover disabled:opacity-60",
                        selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-card text-foreground hover:bg-accent",
                      )}
                    >
                      {selected ? <Check aria-hidden className="size-4 shrink-0" /> : null}
                      <span className="min-w-0 break-words">{t.outcomes[option.value]}</span>
                      <kbd
                        aria-hidden
                        className={cn(
                          "absolute top-1.5 right-2 hidden font-sans text-[11px] font-semibold tabular-nums md:block",
                          selected ? "text-primary-foreground/70" : "text-muted-foreground",
                        )}
                      >
                        {index + 1}
                      </kbd>
                    </button>
                  );
                })}
              </div>

              {outcome === "WRONG_NUMBER" && wrapUp.leadId ? (
                <p className="-mt-2 text-sm font-semibold text-destructive">
                  {t.wrongNumberDnc}
                </p>
              ) : null}

              {outcome === "FOLLOW_UP" ? (
                <fieldset className="flex flex-col gap-3 rounded-xl border p-3">
                  <legend className="px-1 text-sm font-bold">{t.followUp}</legend>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    {FOLLOW_UP_PICKS.map((pick) => {
                      const selected = values.followUpPick === pick.value;
                      return (
                        <button
                          key={pick.value}
                          type="button"
                          aria-pressed={selected}
                          disabled={saving}
                          onClick={() => update({ followUpPick: pick.value })}
                          className={cn(
                            "min-h-12 rounded-lg border px-3 text-sm font-bold outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50",
                            selected ? "border-primary bg-primary/15 text-foreground" : "bg-card hover:bg-accent",
                          )}
                        >
                          {t.followUpPicks[pick.value]}
                        </button>
                      );
                    })}
                  </div>
                  {values.followUpPick === "custom" ? (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${formId}-custom`}>{t.dateAndTime.replace("{zone}", tz.replace(/_/g, " "))}</Label>
                      <Input
                        id={`${formId}-custom`}
                        type="datetime-local"
                        value={values.customFollowUp}
                        disabled={saving}
                        onChange={(event) => update({ customFollowUp: event.target.value })}
                        className="min-h-12"
                      />
                    </div>
                  ) : null}
                  {followUpPreview ? (
                    <p className="text-sm text-muted-foreground">
                      {t.due}{" "}
                      <span className="font-semibold text-foreground tabular-nums">
                        {formatDate(followUpPreview, locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz })}
                      </span>
                    </p>
                  ) : null}
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${formId}-follow-up-note`}>{t.followUpNoteOptional}</Label>
                    <Input
                      id={`${formId}-follow-up-note`}
                      value={values.followUpNote}
                      maxLength={MAX_FOLLOW_UP_NOTE}
                      disabled={saving}
                      onChange={(event) => update({ followUpNote: event.target.value })}
                      className="min-h-12"
                    />
                  </div>
                </fieldset>
              ) : null}

              <div className="flex flex-col gap-1.5">
                {notesOpen ? null : (
                  <button
                    type="button"
                    onClick={() => setNotesOpen(true)}
                    className="inline-flex min-h-12 w-fit items-center rounded-lg px-1 text-sm font-bold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 md:hidden"
                  >
                    {t.addNote}
                  </button>
                )}
                <div className={cn("flex-col gap-1.5", notesOpen ? "flex" : "hidden md:flex")}>
                  <Label htmlFor={`${formId}-notes`}>{t.notesOptional}</Label>
                  <Textarea
                    id={`${formId}-notes`}
                    value={values.notes}
                    maxLength={MAX_CALL_NOTES}
                    rows={3}
                    disabled={saving}
                    onChange={(event) => update({ notes: event.target.value })}
                    className="min-h-20"
                  />
                </div>
              </div>

              {wrapUp.mode === "TEL" ? (
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="mb-1.5 text-sm font-medium">{t.talkTimeOptional}</legend>
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label={t.minutes}
                      inputMode="numeric"
                      placeholder={t.min}
                      value={values.durationMinutes}
                      maxLength={4}
                      disabled={saving}
                      onChange={(event) => update({ durationMinutes: event.target.value })}
                      className="min-h-12 w-20 text-center tabular-nums"
                    />
                    <span aria-hidden className="font-bold text-muted-foreground">
                      :
                    </span>
                    <Input
                      aria-label={t.seconds}
                      inputMode="numeric"
                      placeholder={t.sec}
                      value={values.durationSeconds}
                      maxLength={2}
                      disabled={saving}
                      onChange={(event) => update({ durationSeconds: event.target.value })}
                      className="min-h-12 w-20 text-center tabular-nums"
                    />
                  </div>
                </fieldset>
              ) : null}

              {error ? (
                <p role="alert" className="rounded-lg bg-destructive/15 px-3 py-2 text-sm font-semibold text-destructive">
                  {error}
                </p>
              ) : null}
              {draftUnavailable ? <p role="status" className="text-sm text-destructive">{t.draftRecoveryUnavailable}</p> : null}
              <p role="status" className="sr-only">{saving ? t.savingCallOutcome : ""}</p>
            </div>

            <div className="grid grid-cols-[auto_1fr] gap-2 border-t px-5 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
              <button
                type="button"
                disabled={saving}
                onClick={() => void save(false)}
                className="min-h-14 rounded-xl border bg-card px-6 text-base font-bold outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
              >
                {t.save}
              </button>
              <button
                ref={saveNextRef}
                type="button"
                data-save-next
                disabled={saving}
                onClick={() => void save(true)}
                className="min-h-14 rounded-xl bg-primary px-6 text-lg font-extrabold text-primary-foreground outline-none transition-colors duration-150 hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-popover disabled:opacity-50"
              >
                {saving ? t.saving : t.saveAndNext}
              </button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.closeWithoutLogging}</AlertDialogTitle>
            <AlertDialogDescription>{t.discardCallWarning}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-12">{t.keepLogging}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" className="min-h-12" onClick={() => { removeDraft(storageKey); onDiscard(); }}>
              {t.discard}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

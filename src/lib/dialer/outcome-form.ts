import { CALL_OUTCOMES, isCallOutcome, type CallOutcome } from "@/lib/domain/outcomes";
import { followUpQuickPicks, isValidTimeZone, tryZonedLocalInputToUtc } from "@/lib/domain/time";
import type { CallMode } from "./state";
import type { CallEndReason } from "./types";

export type FollowUpPick = "tomorrow" | "in3days" | "nextWeek" | "custom";

export const FOLLOW_UP_PICKS: ReadonlyArray<{ readonly value: FollowUpPick; readonly label: string }> = [
  { value: "tomorrow", label: "Tomorrow 9am" },
  { value: "in3days", label: "In 3 days" },
  { value: "nextWeek", label: "Next week" },
  { value: "custom", label: "Custom" },
];

export const MAX_CALL_NOTES = 5000;
export const MAX_FOLLOW_UP_NOTE = 1000;
export const MAX_DURATION_SECONDS = 86_400;

/** Desktop shortcut: keys 1-8 pick the outcome in sheet order. */
export function outcomeFromShortcutKey(key: string): CallOutcome | null {
  return /^[1-8]$/.test(key) ? CALL_OUTCOMES[Number(key) - 1] : null;
}

export function resolveFollowUpAt(
  pick: FollowUpPick | null,
  customValue: string,
  timezone: string,
  now: Date,
): Date | null {
  if (pick === null) return null;
  const tz = isValidTimeZone(timezone) ? timezone : "UTC";
  if (pick === "custom") return tryZonedLocalInputToUtc(customValue, tz);
  const picks = followUpQuickPicks(tz, now);
  if (pick === "tomorrow") return picks.tomorrow9am;
  if (pick === "in3days") return picks.in3Days;
  return picks.nextWeek;
}

export type DurationResult = { ok: true; seconds: number | undefined } | { ok: false; error: string };

/** Optional manual talk time for phone calls. Both fields blank means "not entered". */
export function parseManualDuration(minutes: string, seconds: string): DurationResult {
  const m = minutes.trim();
  const s = seconds.trim();
  if (m === "" && s === "") return { ok: true, seconds: undefined };
  if ((m !== "" && !/^\d{1,4}$/.test(m)) || (s !== "" && !/^\d{1,2}$/.test(s))) {
    return { ok: false, error: "Enter the duration as whole minutes and seconds." };
  }
  const secs = s === "" ? 0 : Number(s);
  if (secs > 59) return { ok: false, error: "Seconds must be 59 or less." };
  const total = (m === "" ? 0 : Number(m)) * 60 + secs;
  if (total > MAX_DURATION_SECONDS) return { ok: false, error: "Duration can be at most 24 hours." };
  return { ok: true, seconds: total };
}

export interface OutcomeFormValues {
  outcome: CallOutcome | null;
  followUpPick: FollowUpPick | null;
  customFollowUp: string;
  followUpNote: string;
  notes: string;
  durationMinutes: string;
  durationSeconds: string;
}

export const EMPTY_OUTCOME_FORM: OutcomeFormValues = {
  outcome: null,
  followUpPick: null,
  customFollowUp: "",
  followUpNote: "",
  notes: "",
  durationMinutes: "",
  durationSeconds: "",
};

export interface OutcomeFormTarget {
  mode: CallMode;
  leadId: string | null;
  callId: string | null;
  clientRequestId: string | null;
  timezone: string;
  now: Date;
}

/** The input of logCallAction. */
export interface LogCallPayload {
  outcome: CallOutcome;
  leadId: string | null;
  callId?: string;
  clientRequestId?: string;
  notes?: string;
  followUpAt?: string;
  followUpNote?: string;
  durationSeconds?: number;
}

export type BuildPayloadResult = { ok: true; payload: LogCallPayload } | { ok: false; error: string };

export function buildLogCallPayload(values: OutcomeFormValues, target: OutcomeFormTarget): BuildPayloadResult {
  if (values.outcome === null) return { ok: false, error: "Pick an outcome." };

  const payload: LogCallPayload = { outcome: values.outcome, leadId: target.leadId };
  if (target.mode === "IN_APP") {
    if (!target.callId) return { ok: false, error: "This call can't be logged. Close the sheet and try again." };
    payload.callId = target.callId;
  } else {
    if (!target.leadId || !target.clientRequestId) {
      return { ok: false, error: "This call can't be logged. Close the sheet and try again." };
    }
    payload.clientRequestId = target.clientRequestId;
  }

  const notes = values.notes.trim();
  if (notes.length > MAX_CALL_NOTES) return { ok: false, error: `Notes can be at most ${MAX_CALL_NOTES} characters.` };
  if (notes !== "") payload.notes = notes;

  if (values.outcome === "FOLLOW_UP") {
    if (!target.leadId) return { ok: false, error: "A follow-up needs a lead. Pick another outcome." };
    if (values.followUpPick === null) return { ok: false, error: "Pick when to follow up." };
    const at = resolveFollowUpAt(values.followUpPick, values.customFollowUp, target.timezone, target.now);
    if (at === null) return { ok: false, error: "Enter a valid follow-up date and time." };
    if (at.getTime() <= target.now.getTime()) return { ok: false, error: "Pick a follow-up time in the future." };
    payload.followUpAt = at.toISOString();
    const followUpNote = values.followUpNote.trim();
    if (followUpNote.length > MAX_FOLLOW_UP_NOTE) {
      return { ok: false, error: `The follow-up note can be at most ${MAX_FOLLOW_UP_NOTE} characters.` };
    }
    if (followUpNote !== "") payload.followUpNote = followUpNote;
  }

  if (target.mode === "TEL") {
    const duration = parseManualDuration(values.durationMinutes, values.durationSeconds);
    if (!duration.ok) return duration;
    if (duration.seconds !== undefined) payload.durationSeconds = duration.seconds;
  }

  return { ok: true, payload };
}

export interface EnterKeyTarget {
  tagName: string;
  /** The target is (inside) a button. */
  isButton: boolean;
  /** The button's `data-outcome`, or null. */
  outcome: string | null;
  isSaveNext: boolean;
}

export type OutcomeSheetEnterAction = { kind: "save" } | { kind: "select"; outcome: CallOutcome } | { kind: "ignore" };

/**
 * Enter in the outcome sheet. On an outcome button it picks that outcome, like a click; only Enter on the
 * already selected outcome saves, so the saved outcome is always the one the focused button shows.
 */
export function outcomeSheetEnterAction(target: EnterKeyTarget, selected: CallOutcome | null): OutcomeSheetEnterAction {
  if (target.tagName === "TEXTAREA") return { kind: "ignore" };
  if (target.outcome !== null) {
    if (!isCallOutcome(target.outcome)) return { kind: "ignore" };
    return target.outcome === selected ? { kind: "save" } : { kind: "select", outcome: target.outcome };
  }
  if (target.isSaveNext) return { kind: "save" };
  return target.isButton ? { kind: "ignore" } : { kind: "save" };
}

/** Save & Next is a single tap when the outcome is already chosen and nothing else is required. */
export function isReadyToSave(values: OutcomeFormValues): boolean {
  if (values.outcome === null) return false;
  return values.outcome !== "FOLLOW_UP" || values.followUpPick !== null;
}

/** Server call_status values that mean the lead never answered (Twilio reports them on the child leg). */
export function isUnansweredCallStatus(status: string | null | undefined): boolean {
  return status === "busy" || status === "no-answer" || status === "failed";
}

export function describeCallEnd(mode: CallMode, reason: CallEndReason): string {
  if (mode === "TEL") return "Phone call";
  switch (reason) {
    case "busy":
      return "Line busy";
    case "no-answer":
      return "No answer";
    case "failed":
      return "Call failed";
    case "canceled":
      return "Call canceled";
    default:
      return "Call ended";
  }
}

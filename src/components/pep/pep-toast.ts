"use client";

import { toast } from "sonner";
import type { CallOutcome } from "@/lib/domain/outcomes";
import { milestoneFor, outcomeBucket, pickPepLine, shouldQuipAfterOutcome, type PepBucket } from "@/lib/domain/pep-talk";
import { countLoggedCall, localDate, readPepDay, readPepSetting, rememberPepLine } from "@/lib/pep/storage";

export interface CheerOutcomeInput {
  outcome: CallOutcome;
  /** The lead just called, for lines that name them. */
  business?: string | null;
  /** The logged call's id: a stable seed, so the same call never re-rolls a different line. */
  callId: string;
}

/**
 * Fires the between-calls line after an outcome is logged (docs/DEVIATIONS.md D49).
 *
 * Deliberately fire-and-forget and never throws: a joke failing must not take down the wrap-up that
 * just saved someone's call. The day's counter advances even when no line shows, so "every tenth
 * call" stays true rather than counting only the calls that happened to be funny.
 */
export function cheerOutcome({ outcome, business, callId }: CheerOutcomeInput): void {
  try {
    const setting = readPepSetting();
    if (setting === "off") return;

    const date = localDate();
    const dials = countLoggedCall(date);
    const { recent, target } = readPepDay(date);

    const milestone = milestoneFor(dials, target);
    if (!milestone && !shouldQuipAfterOutcome(dials, callId)) return;

    const bucket: PepBucket = milestone ? `milestone:${milestone}` : outcomeBucket(outcome);
    const line = pickPepLine({ bucket, setting, business, dials, seed: `${callId}:${dials}`, exclude: recent });
    if (!line) return;

    rememberPepLine(date, line.id);
    toast(line.text, { duration: 7000 });
  } catch {
    // Storage blocked, or something else went sideways. Silence is the right failure here.
  }
}

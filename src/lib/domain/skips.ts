// Skipped queue (docs/DEVIATIONS.md D42): the structured reasons an agent can give when skipping a lead, and
// how a closed skip is described. The same values are checked in 20260915001700_skipped_leads.sql.

export const SKIP_REASONS = ["CALL_LATER", "NEEDS_RESEARCH", "BAD_DATA", "NOT_PRIORITY", "OTHER"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const SKIP_REASON_LABELS: Readonly<Record<SkipReason, string>> = {
  CALL_LATER: "Better to call later",
  NEEDS_RESEARCH: "Needs research first",
  BAD_DATA: "Details look wrong",
  NOT_PRIORITY: "Not a priority now",
  OTHER: "Other reason",
};

export const SKIP_RESOLUTIONS = ["RESUMED", "CALLED", "STATUS_CHANGED", "FOLLOW_UP", "REASSIGNED", "SKIPPED_AGAIN"] as const;
export type SkipResolution = (typeof SKIP_RESOLUTIONS)[number];

export const SKIP_RESOLUTION_LABELS: Readonly<Record<SkipResolution, string>> = {
  RESUMED: "Back in the call queue",
  CALLED: "Called",
  STATUS_CHANGED: "Status changed",
  FOLLOW_UP: "Follow-up scheduled",
  REASSIGNED: "Reassigned",
  SKIPPED_AGAIN: "Skipped again",
};

export const MAX_SKIP_NOTE_LENGTH = 500;

export function isSkipReason(value: unknown): value is SkipReason {
  return typeof value === "string" && (SKIP_REASONS as readonly string[]).includes(value);
}

export function isSkipResolution(value: unknown): value is SkipResolution {
  return typeof value === "string" && (SKIP_RESOLUTIONS as readonly string[]).includes(value);
}

/** "Details look wrong: number disconnected", or just the label or note, or "No reason given". */
export function describeSkipReason(reason: SkipReason | null, note: string | null): string {
  const label = reason ? SKIP_REASON_LABELS[reason] : null;
  const text = note?.trim() || null;
  if (label && text) return reason === "OTHER" ? text : `${label}: ${text}`;
  return label ?? text ?? "No reason given";
}

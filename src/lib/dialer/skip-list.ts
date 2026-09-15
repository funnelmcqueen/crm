// Next Lead skip list, carried in the URL (`/next?skip=a,b` and `/leads/<id>?flow=next&skip=a,b`).

export const MAX_SKIP_IDS = 200;

export const NEXT_LEAD_REASONS = ["VOICEMAIL", "OVERDUE", "DUE_TODAY", "NEW", "RETRY"] as const;
export type NextLeadReason = (typeof NEXT_LEAD_REASONS)[number];

export const NEXT_LEAD_REASON_LABELS: Readonly<Record<NextLeadReason, string>> = {
  VOICEMAIL: "Unheard voicemail",
  OVERDUE: "Overdue follow-up",
  DUE_TODAY: "Follow-up due today",
  NEW: "New lead",
  RETRY: "Try again",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Longer than any valid list (200 ids plus separators); the rest is ignored. */
const MAX_RAW_LENGTH = MAX_SKIP_IDS * 40;

export function isNextLeadReason(value: unknown): value is NextLeadReason {
  return typeof value === "string" && (NEXT_LEAD_REASONS as readonly string[]).includes(value);
}

/** Valid, lower-cased, de-duplicated uuids in order. Keeps the most recent MAX_SKIP_IDS. */
export function parseSkipParam(raw: string | readonly string[] | null | undefined): string[] {
  const values = raw == null ? [] : typeof raw === "string" ? [raw] : raw;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of values) {
    const text = value.length > MAX_RAW_LENGTH ? value.slice(-MAX_RAW_LENGTH) : value;
    for (const part of text.split(",")) {
      const id = part.trim().toLowerCase();
      if (UUID.test(id) && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids.slice(-MAX_SKIP_IDS);
}

export function appendSkip(ids: readonly string[], leadId: string): string[] {
  return parseSkipParam([...ids, leadId].join(","));
}

export function nextLeadHref(skip: readonly string[]): string {
  const ids = parseSkipParam(skip.join(","));
  return ids.length > 0 ? `/next?skip=${ids.join(",")}` : "/next";
}

export function leadFlowHref(leadId: string, skip: readonly string[], reason?: string | null): string {
  const ids = parseSkipParam(skip.join(","));
  let href = `/leads/${encodeURIComponent(leadId)}?flow=next`;
  if (ids.length > 0) href += `&skip=${ids.join(",")}`;
  if (isNextLeadReason(reason)) href += `&reason=${reason}`;
  return href;
}

import { z } from "zod";
import { CALL_OUTCOMES } from "@/lib/domain/outcomes";

const PREFIX = "fmq.draft.";
const MAX_AGE = 12 * 60 * 60 * 1000;
// SPA/back navigation must retain drafts even when the browser blocks sessionStorage.
const memoryDrafts = new Map<string, string | null>();
export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
function sessionStore(): DraftStore | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}
export function draftKey(userId: string, kind: "lead" | "outcome" | "wrapup", id: string): string {
  return `${PREFIX}${userId}.${kind}.${id}`;
}
export function readDraft<T>(key: string, schema: z.ZodType<T>, store: DraftStore | null = sessionStore(), now = Date.now()): T | null {
  let raw: string | null = null;
  try { raw = memoryDrafts.has(key) ? memoryDrafts.get(key) ?? null : store?.getItem(key) ?? null; }
  catch { raw = memoryDrafts.get(key) ?? null; }
  try {
    if (!raw) return null;
    const envelope = z.object({ savedAt: z.number().finite(), data: schema }).safeParse(JSON.parse(raw));
    if (!envelope.success || envelope.data.savedAt > now + 60_000 || now - envelope.data.savedAt > MAX_AGE) {
      removeDraft(key, store);
      return null;
    }
    return envelope.data.data;
  } catch { return null; }
}
export function writeDraft(key: string, data: unknown, store: DraftStore | null = sessionStore(), now = Date.now()): boolean {
  try {
    const raw = JSON.stringify({ savedAt: now, data });
    memoryDrafts.set(key, raw);
    if (!store) return false;
    store.setItem(key, raw);
    return true;
  } catch { return false; }
}
export function removeDraft(key: string, store: DraftStore | null = sessionStore()): void {
  // A tombstone also wins over stale storage if removal is temporarily unavailable.
  memoryDrafts.set(key, null);
  try { store?.removeItem(key); } catch { /* Storage can be disabled. */ }
}
export function clearWorkspaceDrafts(store: DraftStore | null = sessionStore()): void {
  memoryDrafts.clear();
  try {
    if (!store) return;
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i);
      if (key?.startsWith(PREFIX)) store.removeItem(key);
    }
  } catch { /* Sign-out must still complete. */ }
}
export const leadDraftSchema = z.string().max(10_000);
export const outcomeDraftSchema = z.object({
  outcome: z.enum(CALL_OUTCOMES).nullable(),
  followUpPick: z.enum(["tomorrow", "in3days", "nextWeek", "custom"]).nullable(),
  customFollowUp: z.string().max(100), followUpNote: z.string().max(1000), notes: z.string().max(5000),
  durationMinutes: z.string().max(4), durationSeconds: z.string().max(2),
});
export const wrapUpDraftSchema = z.object({
  leadId: z.uuid().nullable(), callId: z.uuid().nullable(), clientRequestId: z.uuid().nullable(),
  mode: z.enum(["IN_APP", "TEL"]), endReason: z.enum(["completed", "busy", "no-answer", "failed", "canceled"]),
  preselectedOutcome: z.enum(CALL_OUTCOMES).nullable(), label: z.string().max(500),
}).refine((v) => v.mode === "IN_APP" ? v.callId !== null : v.leadId !== null && v.clientRequestId !== null);

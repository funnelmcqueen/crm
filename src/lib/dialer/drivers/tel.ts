// The tel: driver has no provider: CALL is a plain <a href="tel:..."> and this module remembers the
// tapped call in sessionStorage so the outcome sheet can open when the page is visible again, even
// after the browser discarded and reloaded the tab.
import type { WrapUp } from "../state";

export const PENDING_TEL_STORAGE_KEY = "fmq.pendingTel";
/** Ignore visibility/focus events that arrive right after the tap (before the phone app took over). */
export const TEL_RETURN_MIN_MS = 1000;
/** A pending phone call older than this is dropped instead of restored. */
export const PENDING_TEL_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface PendingTel {
  /** The signed-in user who tapped CALL; another user in the same tab never restores it. */
  userId: string;
  leadId: string | null;
  /** Server-created call ID for a no-lead manual phone call. Legacy lead calls omit this. */
  callId?: string | null;
  label: string;
  clientRequestId: string;
  startedAt: number;
  /** "calling" until the agent returns; "wrap-up" once the outcome sheet has opened. */
  stage: "calling" | "wrap-up";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePendingTel(raw: string | null | undefined, now: number, userId: string): PendingTel | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { leadId, callId, label, clientRequestId, startedAt, stage } = record;
  if (record.userId !== userId) return null;
  if (leadId === null) {
    if (typeof callId !== "string" || !UUID.test(callId)) return null;
  } else if (typeof leadId !== "string" || !UUID.test(leadId)) return null;
  if (callId !== undefined && callId !== null && (typeof callId !== "string" || !UUID.test(callId))) return null;
  if (typeof clientRequestId !== "string" || !UUID.test(clientRequestId)) return null;
  if (typeof label !== "string" || label.length > 500) return null;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  if (stage !== "calling" && stage !== "wrap-up") return null;
  if (startedAt > now + 60_000 || now - startedAt > PENDING_TEL_MAX_AGE_MS) return null;
  return { userId, leadId: leadId as string | null, ...(callId === undefined ? {} : { callId: callId as string | null }), label, clientRequestId, startedAt, stage };
}

export function shouldOpenTelOutcome(pending: Pick<PendingTel, "startedAt">, now: number): boolean {
  return now - pending.startedAt >= TEL_RETURN_MIN_MS;
}

export function pendingTelWrapUp(pending: PendingTel): WrapUp {
  return {
    leadId: pending.leadId,
    callId: pending.callId ?? null,
    clientRequestId: pending.clientRequestId,
    mode: "TEL",
    endReason: "completed",
    preselectedOutcome: null,
    label: pending.label,
  };
}

/** A v4 UUID. crypto.randomUUID only exists in secure contexts (not on a LAN http:// origin). */
export function newClientRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): SessionStore | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readPendingTel(
  now: number,
  userId: string,
  store: SessionStore | null = sessionStore(),
): PendingTel | null {
  try {
    return parsePendingTel(store?.getItem(PENDING_TEL_STORAGE_KEY), now, userId);
  } catch {
    return null;
  }
}

export function writePendingTel(pending: PendingTel, store: SessionStore | null = sessionStore()): void {
  try {
    store?.setItem(PENDING_TEL_STORAGE_KEY, JSON.stringify(pending));
  } catch {
    // Without storage the sticky bar still works until the tab reloads.
  }
}

export function clearPendingTel(store: SessionStore | null = sessionStore()): void {
  try {
    store?.removeItem(PENDING_TEL_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

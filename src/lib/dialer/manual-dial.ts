import { DIALER_MESSAGES, outboundErrorMessage } from "./messages";
import type { CallMode, DialerState } from "./state";
import type { ManualDialTarget } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canStartManualDial(state: DialerState, recovering: boolean): boolean {
  return !recovering && state.kind === "idle";
}

export type ManualCallRequest = { ok: true; callId: string } | { ok: false; message: string; status?: number };

/** The browser sends the raw keypad value; the server owns normalization and call creation. */
export async function requestManualCallId(
  target: ManualDialTarget,
  mode: CallMode,
  fetcher: typeof fetch = fetch,
): Promise<ManualCallRequest> {
  try {
    const response = await fetcher("/api/calls/manual-outbound", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: target.phone, mode }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, status: response.status, message: outboundErrorMessage(response.status, body) };
    const callId = typeof body === "object" && body !== null ? (body as { callId?: unknown }).callId : undefined;
    return typeof callId === "string" && UUID.test(callId)
      ? { ok: true, callId }
      : { ok: false, message: DIALER_MESSAGES.startFailed };
  } catch {
    return { ok: false, message: DIALER_MESSAGES.startFailed };
  }
}

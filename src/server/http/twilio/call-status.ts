import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

export type CallStatus = "queued" | "ringing" | "in-progress" | "completed" | "busy" | "no-answer" | "failed" | "canceled";

const TERMINAL: ReadonlySet<CallStatus> = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

/** `CallStatus` of a status callback. `initiated`/`answered` are event names some callbacks report. */
const CALLBACK_STATUS: Readonly<Record<string, CallStatus>> = {
  queued: "queued",
  initiated: "queued",
  ringing: "ringing",
  answered: "in-progress",
  "in-progress": "in-progress",
  completed: "completed",
  busy: "busy",
  "no-answer": "no-answer",
  failed: "failed",
  canceled: "canceled",
};

/** `DialCallStatus` of a `<Dial action>` request: the dial is over, so `answered` means completed. */
const DIAL_STATUS: Readonly<Record<string, CallStatus>> = {
  completed: "completed",
  answered: "completed",
  busy: "busy",
  "no-answer": "no-answer",
  failed: "failed",
  canceled: "canceled",
};

export function callbackStatus(value: string | undefined): CallStatus | null {
  return value !== undefined && Object.hasOwn(CALLBACK_STATUS, value) ? CALLBACK_STATUS[value] : null;
}

export function dialStatus(value: string | undefined): CallStatus | null {
  return value !== undefined && Object.hasOwn(DIAL_STATUS, value) ? DIAL_STATUS[value] : null;
}

export function isTerminalStatus(status: CallStatus): boolean {
  return TERMINAL.has(status);
}

const MAX_DURATION_SECONDS = 86_400;

export function parseDuration(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,6}$/.test(value)) return null;
  const seconds = Number(value);
  return seconds <= MAX_DURATION_SECONDS ? seconds : null;
}

/** apply_call_status is idempotent and never moves a terminal status backwards. */
export async function applyCallStatus(
  admin: SupabaseClient<Database>,
  callSid: string,
  status: CallStatus,
  duration: number | null,
): Promise<boolean> {
  const { data, error } = await admin.rpc("apply_call_status", {
    p_call_sid: callSid,
    p_status: status,
    ...(duration === null ? {} : { p_duration: duration }),
  });
  if (error) throw error;
  return data === true;
}

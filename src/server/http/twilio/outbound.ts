import "server-only";
import { z } from "zod";
import { isE164 } from "@/lib/domain/phone";
import { logTwilioWarning } from "@/server/twilio/log";
import { isCallSid } from "@/server/twilio/sids";
import { failureTwiml, outboundDialTwiml } from "@/server/twilio/twiml";
import { respondInbound } from "@/server/http/twilio/inbound";
import { runTwilioWebhook, type WebhookContext, type WebhookDeps } from "@/server/http/twilio/webhook";

/** A pre-created call row must be dialed soon after CALL was tapped. */
export const OUTBOUND_ROW_MAX_AGE_MS = 10 * 60_000;

const callIdSchema = z.uuid();

export type OutboundRefusal =
  | "call_sid"
  | "call_id"
  | "call_not_dialable"
  | "identity_mismatch"
  | "user_not_allowed"
  | "lead_not_allowed"
  | "do_not_contact"
  | "no_caller_id"
  | "call_in_progress"
  | "already_claimed";

/** Same window as create_outbound_call's call_in_progress check. */
export const LIVE_CALL_WINDOW_MS = 2 * 3_600_000;
const LIVE_CALL_STATUSES = ["queued", "ringing", "in-progress"] as const;
const FINAL_CALL_STATUSES: ReadonlySet<string> = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

/**
 * SPEC 7a "One active call per agent" (D23). create_outbound_call already refuses while a live call has no
 * outcome, but ignores one whose outcome was logged (D15), so the webhook asks Twilio about those before
 * dialing another call. A call Twilio reports as finished gets that final status recorded (its status
 * callback was lost) and no longer blocks; a call still live, or a failed lookup, refuses.
 */
async function noOtherLiveCall(ctx: WebhookContext, callId: string, userId: string): Promise<boolean> {
  const { admin, now, params } = ctx;
  const { data: live, error } = await admin
    .from("calls")
    .select("id, provider_call_sid")
    .eq("user_id", userId)
    .neq("id", callId)
    .not("outcome", "is", null)
    .in("call_status", [...LIVE_CALL_STATUSES])
    .gte("created_at", new Date(now.getTime() - LIVE_CALL_WINDOW_MS).toISOString());
  if (error) throw error;

  for (const other of live ?? []) {
    if (!isCallSid(other.provider_call_sid)) return false;
    let status: string | null;
    try {
      status = await ctx.rest().fetchCallStatus(other.provider_call_sid);
    } catch (lookupError) {
      logTwilioWarning("outbound_live_call_lookup_failed", {
        callSid: params.CallSid,
        reason: lookupError instanceof Error ? lookupError.message : "unknown",
      });
      return false;
    }
    if (status === null) continue;
    if (!FINAL_CALL_STATUSES.has(status)) return false;
    const { error: statusError } = await admin.rpc("apply_call_status", { p_call_sid: other.provider_call_sid, p_status: status });
    if (statusError) throw statusError;
  }
  return true;
}

/**
 * Every check trusts only the signed params and the database. The client sends nothing but callId, and
 * the Twilio identity (`From: client:<userId>`) must own the row.
 */
export async function respondOutbound(ctx: WebhookContext): Promise<string> {
  const { params, admin, appBaseUrl, now } = ctx;
  const refuse = (reason: OutboundRefusal): string => {
    logTwilioWarning("outbound_refused", { reason, callSid: params.CallSid });
    return failureTwiml();
  };

  const callSid = params.CallSid;
  if (!isCallSid(callSid)) return refuse("call_sid");
  const callId = callIdSchema.safeParse(params.callId);
  if (!callId.success) return refuse("call_id");

  const { data: call, error: callError } = await admin
    .from("calls")
    .select("id, lead_id, user_id, direction, mode, provider_call_sid, call_status, outcome")
    .eq("id", callId.data)
    .gte("created_at", new Date(now.getTime() - OUTBOUND_ROW_MAX_AGE_MS).toISOString())
    .maybeSingle();
  if (callError) throw callError;
  if (
    !call ||
    call.direction !== "OUTBOUND" ||
    call.mode !== "IN_APP" ||
    call.provider_call_sid !== null ||
    call.call_status !== null ||
    call.outcome !== null ||
    call.user_id === null ||
    call.lead_id === null
  ) {
    return refuse("call_not_dialable");
  }
  if (params.From !== `client:${call.user_id}`) return refuse("identity_mismatch");

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, role, active, in_app_calling_enabled")
    .eq("id", call.user_id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile || !profile.active || !profile.in_app_calling_enabled) return refuse("user_not_allowed");

  const { data: lead, error: leadError } = await admin
    .from("leads")
    .select("id, phone, status, assigned_to")
    .eq("id", call.lead_id)
    .maybeSingle();
  if (leadError) throw leadError;
  if (!lead || (lead.assigned_to !== call.user_id && profile.role !== "ADMIN") || !isE164(lead.phone)) {
    return refuse("lead_not_allowed");
  }
  if (lead.status === "DO_NOT_CONTACT") return refuse("do_not_contact");

  if (!(await noOtherLiveCall(ctx, call.id, call.user_id))) return refuse("call_in_progress");

  const { data: numbers, error: claimError } = await admin.rpc("claim_caller_id", { p_user_id: call.user_id });
  if (claimError) throw claimError;
  const callerId = numbers?.[0];
  if (!callerId || !isE164(callerId.e164)) return refuse("no_caller_id");

  const { data: claimed, error: updateError } = await admin
    .from("calls")
    .update({ provider_call_sid: callSid, phone_number_id: callerId.phone_number_id, call_status: "queued" })
    .eq("id", call.id)
    .is("provider_call_sid", null)
    .is("call_status", null)
    .is("outcome", null)
    .select("id");
  if (updateError) {
    if (updateError.code === "23505") return refuse("already_claimed");
    throw updateError;
  }
  if (!claimed || claimed.length !== 1) return refuse("already_claimed");

  return outboundDialTwiml({ appBaseUrl, callerId: callerId.e164, to: lead.phone });
}

/** TwiML App Voice URL. Numbers point at the TwiML App too, so non-client callers are inbound (D7). */
export function handleTwilioOutbound(req: Request, deps: Partial<WebhookDeps> = {}): Promise<Response> {
  return runTwilioWebhook(req, deps, "outbound", "failure-twiml", (ctx) =>
    (ctx.params.From ?? "").startsWith("client:") ? respondOutbound(ctx) : respondInbound(ctx),
  );
}

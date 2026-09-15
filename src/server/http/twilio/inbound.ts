import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { decideInboundRoute, loadInboundFacts, type InboundDecision } from "@/server/twilio/inbound-routing";
import { logTwilioWarning } from "@/server/twilio/log";
import { isCallSid } from "@/server/twilio/sids";
import { failureTwiml, ringClientTwiml, voicemailTwiml } from "@/server/twilio/twiml";
import { runTwilioWebhook, type WebhookContext, type WebhookDeps } from "@/server/http/twilio/webhook";

export const DEFAULT_VOICEMAIL_GREETING = "Sorry we missed your call. Please leave a message after the beep.";

export async function loadVoicemailGreeting(admin: SupabaseClient<Database>): Promise<string> {
  const { data, error } = await admin.from("settings").select("voicemail_greeting").limit(1).maybeSingle();
  if (error) throw error;
  const greeting = data?.voicemail_greeting?.trim();
  return greeting ? greeting : DEFAULT_VOICEMAIL_GREETING;
}

type InsertResult = { kind: "inserted"; callId: string } | { kind: "existing"; callId: string; userId: string | null } | { kind: "conflict" };

async function insertInboundCall(
  admin: SupabaseClient<Database>,
  callSid: string,
  decision: InboundDecision,
  remoteE164: string | null,
): Promise<InsertResult> {
  const { data, error } = await admin
    .from("calls")
    .insert({
      direction: "INBOUND",
      mode: "IN_APP",
      lead_id: decision.leadId,
      user_id: decision.userId,
      phone_number_id: decision.phoneNumberId,
      remote_e164: remoteE164,
      provider_call_sid: callSid,
    })
    .select("id")
    .single();
  if (!error && data) return { kind: "inserted", callId: data.id };
  if (error?.code !== "23505") throw error ?? new Error("inbound call insert returned no row");

  // Twilio retried the same call: reuse its row rather than logging the call twice.
  const existing = await admin
    .from("calls")
    .select("id, user_id, direction")
    .eq("provider_call_sid", callSid)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (!existing.data || existing.data.direction !== "INBOUND") return { kind: "conflict" };
  return { kind: "existing", callId: existing.data.id, userId: existing.data.user_id };
}

/** Inbound routing (ARCHITECTURE 7). Also used by /outbound for callers that are not `client:` identities. */
export async function respondInbound(ctx: WebhookContext): Promise<string> {
  const { params, admin, appBaseUrl, now } = ctx;
  const callSid = params.CallSid;
  if (!isCallSid(callSid)) {
    logTwilioWarning("inbound_refused", { reason: "call_sid", from: params.From });
    return failureTwiml();
  }

  const facts = await loadInboundFacts(admin, params.From, params.To, now);
  const decision = decideInboundRoute(facts, now);
  const inserted = await insertInboundCall(admin, callSid, decision, facts.fromE164);

  if (inserted.kind === "conflict") {
    logTwilioWarning("inbound_refused", { reason: "call_sid_reused", callSid });
    return failureTwiml();
  }
  const sameTarget = inserted.kind === "inserted" || inserted.userId === decision.userId;
  if (decision.action === "ring" && decision.userId && sameTarget) {
    return ringClientTwiml({ appBaseUrl, identity: decision.userId, callId: inserted.callId });
  }
  return voicemailTwiml({ appBaseUrl, greeting: await loadVoicemailGreeting(admin) });
}

export function handleTwilioInbound(req: Request, deps: Partial<WebhookDeps> = {}): Promise<Response> {
  return runTwilioWebhook(req, deps, "inbound", "failure-twiml", respondInbound);
}

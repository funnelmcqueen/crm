import "server-only";
import { logTwilioError, logTwilioWarning } from "@/server/twilio/log";
import { isCallSid, isRecordingSid } from "@/server/twilio/sids";
import { emptyTwiml, goodbyeTwiml, voicemailTwiml } from "@/server/twilio/twiml";
import { applyCallStatus, callbackStatus, dialStatus, isTerminalStatus, parseDuration } from "@/server/http/twilio/call-status";
import { loadVoicemailGreeting } from "@/server/http/twilio/inbound";
import { runTwilioWebhook, type WebhookDeps } from "@/server/http/twilio/webhook";

/** `<Number statusCallback>`: child-leg events carry ParentCallSid, which is the row's provider_call_sid. */
export function handleTwilioStatus(req: Request, deps: Partial<WebhookDeps> = {}): Promise<Response> {
  return runTwilioWebhook(req, deps, "status", "server-error", async ({ params, admin }) => {
    const callSid = params.ParentCallSid || params.CallSid;
    const status = callbackStatus(params.CallStatus);
    if (!isCallSid(callSid) || !status) {
      logTwilioWarning("status_ignored", { callSid, status: params.CallStatus });
      return emptyTwiml();
    }
    const duration = isTerminalStatus(status) ? parseDuration(params.CallDuration) : null;
    await applyCallStatus(admin, callSid, status, duration);
    return emptyTwiml();
  });
}

/** Outbound `<Dial action>`: final dial status and talk time for the parent call. */
export function handleTwilioDialComplete(req: Request, deps: Partial<WebhookDeps> = {}): Promise<Response> {
  return runTwilioWebhook(req, deps, "dial-complete", "server-error", async ({ params, admin }) => {
    const status = dialStatus(params.DialCallStatus);
    if (!isCallSid(params.CallSid) || !status) {
      logTwilioWarning("dial_complete_ignored", { callSid: params.CallSid, status: params.DialCallStatus });
      return emptyTwiml();
    }
    await applyCallStatus(admin, params.CallSid, status, parseDuration(params.DialCallDuration));
    return emptyTwiml();
  });
}

/** Inbound `<Dial action>`: an answered call ends; anything else goes to voicemail. */
export function handleTwilioInboundDialComplete(req: Request, deps: Partial<WebhookDeps> = {}): Promise<Response> {
  return runTwilioWebhook(req, deps, "inbound-dial-complete", "failure-twiml", async ({ params, admin, appBaseUrl }) => {
    const status = dialStatus(params.DialCallStatus);
    if (isCallSid(params.CallSid) && status) {
      try {
        await applyCallStatus(admin, params.CallSid, status, parseDuration(params.DialCallDuration));
      } catch (error) {
        // The caller must still reach voicemail when the status write fails.
        logTwilioError("inbound_status_failed", error, { callSid: params.CallSid });
      }
    }
    if (status === "completed") return emptyTwiml();
    return voicemailTwiml({ appBaseUrl, greeting: await loadVoicemailGreeting(admin) });
  });
}

/** `<Record recordingStatusCallback>`: stores the SID once and creates the owner's follow-up (record_voicemail). */
export function handleTwilioRecordingStatus(req: Request, deps: Partial<WebhookDeps> = {}): Promise<Response> {
  return runTwilioWebhook(req, deps, "recording-status", "server-error", async ({ params, admin }) => {
    if (params.RecordingStatus !== undefined && params.RecordingStatus !== "completed") return emptyTwiml();
    if (!isCallSid(params.CallSid) || !isRecordingSid(params.RecordingSid)) {
      logTwilioWarning("recording_ignored", { callSid: params.CallSid });
      return emptyTwiml();
    }
    const { error } = await admin.rpc("record_voicemail", {
      p_call_sid: params.CallSid,
      p_recording_sid: params.RecordingSid,
      p_duration: parseDuration(params.RecordingDuration) ?? 0,
    });
    if (error) throw error;
    return emptyTwiml();
  });
}

/** `<Record action>`: the caller finished the message. */
export function handleTwilioVoicemailComplete(req: Request, deps: Partial<WebhookDeps> = {}): Promise<Response> {
  return runTwilioWebhook(req, deps, "voicemail-complete", "server-error", async () => goodbyeTwiml());
}

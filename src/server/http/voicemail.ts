import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/lib/database.types";
import { getRouteAuth } from "@/server/context";
import { getDialerDriver, getServerEnv, isTwilioConfigured, type ServerEnv } from "@/server/env";
import { httpError } from "@/server/errors";
import { createAdminClient } from "@/server/supabase/admin";
import { logTwilioError, logTwilioWarning } from "@/server/twilio/log";
import { createTwilioRest, type TwilioRest } from "@/server/twilio/rest";
import { isRecordingSid } from "@/server/twilio/sids";
import { toneResponse } from "@/server/http/voicemail-tone";

export interface VoicemailDeps {
  env: ServerEnv;
  /** Service role, used only for get_voicemail_recording with the verified session user (D13). */
  adminClient: SupabaseClient<Database>;
  rest: TwilioRest;
}

const callIdSchema = z.uuid();

const AUDIO_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } as const;
const FORWARDED_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"] as const;

/** GET /api/voicemail/[callId]: streams the recording server-side. The SID never leaves the server. */
export async function handleVoicemail(req: Request, callId: string, deps: Partial<VoicemailDeps> = {}): Promise<Response> {
  if (!callIdSchema.safeParse(callId).success) return httpError("not_found");

  let auth: Awaited<ReturnType<typeof getRouteAuth>>;
  try {
    auth = await getRouteAuth(req);
  } catch {
    return httpError("unavailable");
  }
  const { ctx, applyCookies } = auth;
  if (!ctx || !ctx.profile.active) return applyCookies(httpError("unauthorized"));

  const env = deps.env ?? getServerEnv();
  const admin = deps.adminClient ?? createAdminClient();
  const { data: recordingSid, error } = await admin.rpc("get_voicemail_recording", {
    p_call_id: callId,
    p_user_id: ctx.userId,
  });
  if (error) {
    logTwilioError("voicemail_lookup_failed", error);
    return applyCookies(httpError("internal"));
  }
  // Inaccessible, missing, not a voicemail, or a malformed SID: all the same 404.
  if (typeof recordingSid !== "string" || !isRecordingSid(recordingSid)) return applyCookies(httpError("not_found"));

  const range = req.headers.get("range");
  const twilioConfigured = isTwilioConfigured(env);
  // The generated tone is a development convenience and must never stand in for a real recording.
  // D24 refuses DIALER_DRIVER=mock in production so the app cannot fake calls; this is the same rule
  // for the media path. An unconfigured production deployment (the documented fallback: unset
  // DIALER_DRIVER resolves to `tel` there) would otherwise answer every voicemail with a 440 Hz beep,
  // with nothing in the player to say so — and log_call marks that lead's voicemails handled once the
  // agent moves on, so a real message would be silently marked as dealt with, unheard.
  if (env.NODE_ENV !== "production" && (!twilioConfigured || getDialerDriver(env) === "mock")) {
    return applyCookies(toneResponse(range, AUDIO_HEADERS));
  }
  if (!twilioConfigured) {
    logTwilioWarning("voicemail_unconfigured", { callId });
    return applyCookies(httpError("unavailable"));
  }

  const rest = deps.rest ?? createTwilioRest(env);
  let upstream: Response;
  try {
    upstream = await rest.fetchRecording(recordingSid, range);
  } catch (fetchError) {
    logTwilioError("voicemail_fetch_failed", fetchError);
    return applyCookies(httpError("unavailable"));
  }
  if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 416) {
    await upstream.body?.cancel().catch(() => undefined);
    logTwilioWarning("voicemail_upstream_status", { status: upstream.status });
    return applyCookies(httpError(upstream.status === 404 ? "not_found" : "unavailable"));
  }

  const headers = new Headers(AUDIO_HEADERS);
  for (const name of FORWARDED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (!headers.has("content-type")) headers.set("Content-Type", "audio/mpeg");
  return applyCookies(new Response(upstream.status === 416 ? null : upstream.body, { status: upstream.status, headers }));
}

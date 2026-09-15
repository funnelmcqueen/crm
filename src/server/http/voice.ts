import "server-only";
import { z } from "zod";
import { getRouteAuth, requireActive } from "@/server/context";
import { getDialerDriver, getServerEnv, isTwilioConfigured, type ServerEnv } from "@/server/env";
import { AppError, httpError, mapPostgrestError, toHttpResponse } from "@/server/errors";
import { createVoiceAccessToken } from "@/server/twilio/token";
import { isAllowedOrigin, jsonResponse, NO_STORE } from "@/server/http/browser";

export interface BrowserRouteDeps {
  env: ServerEnv;
}

type Auth = Awaited<ReturnType<typeof getRouteAuth>>;

/** Origin check, then session. Returns a finished response when either fails. */
async function authenticate(req: Request, env: ServerEnv): Promise<{ response: Response } | { auth: Auth }> {
  if (!isAllowedOrigin(req, env)) return { response: httpError("forbidden") };
  try {
    return { auth: await getRouteAuth(req) };
  } catch (error) {
    return { response: toHttpResponse(error) };
  }
}

/** POST /api/voice/token → { token, identity, ttl } for the Twilio Voice SDK. */
export async function handleVoiceToken(req: Request, deps: Partial<BrowserRouteDeps> = {}): Promise<Response> {
  const env = deps.env ?? getServerEnv();
  const result = await authenticate(req, env);
  if ("response" in result) return result.response;
  const { ctx, applyCookies } = result.auth;
  try {
    const active = requireActive(ctx);
    if (!active.profile.in_app_calling_enabled) throw new AppError("forbidden");
    if (getDialerDriver(env) !== "twilio" || !isTwilioConfigured(env)) throw new AppError("unavailable");

    const { data: allowed, error } = await active.supabase.rpc("consume_rate_limit", { p_bucket: "voice_token" });
    if (error) throw mapPostgrestError(error);
    if (allowed !== true) throw new AppError("rate_limited");

    const { token, ttl } = createVoiceAccessToken(env, active.userId);
    return applyCookies(jsonResponse({ token, identity: active.userId, ttl }));
  } catch (error) {
    return applyCookies(toHttpResponse(error));
  }
}

/** POST /api/voice/presence: the registered Device's heartbeat, used for inbound routing. */
export async function handleVoicePresence(req: Request, deps: Partial<BrowserRouteDeps> = {}): Promise<Response> {
  const env = deps.env ?? getServerEnv();
  const result = await authenticate(req, env);
  if ("response" in result) return result.response;
  const { ctx, applyCookies } = result.auth;
  try {
    const active = requireActive(ctx);
    const { error } = await active.supabase.rpc("touch_device_presence");
    if (error) throw mapPostgrestError(error);
    return applyCookies(new Response(null, { status: 204, headers: NO_STORE }));
  } catch (error) {
    return applyCookies(toHttpResponse(error));
  }
}

const outboundBodySchema = z.object({ leadId: z.uuid() });

/**
 * POST /api/calls/outbound { leadId } → 201 { callId }. A body that is not JSON is 400; any well-formed
 * body whose lead the caller cannot dial is 404 with the same body as a random id.
 */
export async function handleCallsOutbound(req: Request, deps: Partial<BrowserRouteDeps> = {}): Promise<Response> {
  const env = deps.env ?? getServerEnv();
  const result = await authenticate(req, env);
  if ("response" in result) return result.response;
  const { ctx, applyCookies } = result.auth;
  try {
    const active = requireActive(ctx);

    let body: unknown;
    try {
      const text = await req.text();
      if (text.trim() === "") throw new AppError("validation");
      body = JSON.parse(text);
    } catch {
      throw new AppError("validation");
    }
    const parsed = outboundBodySchema.safeParse(body);
    if (!parsed.success) throw new AppError("not_found");

    const { data: callId, error } = await active.supabase.rpc("create_outbound_call", { p_lead_id: parsed.data.leadId });
    if (error) {
      const appError = mapPostgrestError(error);
      if (appError.code === "conflict" && appError.reason) {
        return applyCookies(jsonResponse({ error: "conflict", reason: appError.reason }, 409));
      }
      throw appError;
    }
    if (typeof callId !== "string") throw new AppError("internal");
    return applyCookies(jsonResponse({ callId }, 201));
  } catch (error) {
    return applyCookies(toHttpResponse(error));
  }
}

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { getServerEnv, type ServerEnv } from "@/server/env";
import { createAdminClient } from "@/server/supabase/admin";
import { logTwilioError, logTwilioWarning } from "@/server/twilio/log";
import { createTwilioRest, type TwilioRest } from "@/server/twilio/rest";
import { validateTwilioWebhook, type TwilioParams } from "@/server/twilio/signature";
import { failureTwiml, twimlResponse } from "@/server/twilio/twiml";

export interface WebhookDeps {
  env: ServerEnv;
  /** Service role: webhooks have no user session (ARCHITECTURE golden rule 2b). */
  adminClient: SupabaseClient<Database>;
  rest: TwilioRest;
  now: () => Date;
}

export interface WebhookContext {
  /** Signed Twilio params. The only request input a webhook may trust. */
  params: TwilioParams;
  appBaseUrl: string;
  admin: SupabaseClient<Database>;
  /** The Twilio REST client, created on first use. */
  rest: () => TwilioRest;
  now: Date;
}

export type WebhookErrorMode = "failure-twiml" | "server-error";

export function forbiddenResponse(): Response {
  return new Response("Forbidden", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * Signature + AccountSid check, then the handler. Voice-flow routes answer errors with failure TwiML
 * (the caller hears a short apology); callback routes answer 500 so the failure shows in Twilio's debugger.
 */
export async function runTwilioWebhook(
  req: Request,
  deps: Partial<WebhookDeps>,
  route: string,
  onError: WebhookErrorMode,
  handler: (ctx: WebhookContext) => Promise<string>,
): Promise<Response> {
  let env: ServerEnv;
  try {
    env = deps.env ?? getServerEnv();
  } catch (error) {
    logTwilioError("webhook_env_invalid", error, { route });
    return forbiddenResponse();
  }

  const validation = await validateTwilioWebhook(req, env);
  if (!validation.ok || !env.APP_BASE_URL) {
    logTwilioWarning("webhook_rejected", { route });
    return forbiddenResponse();
  }

  const params = validation.params;
  try {
    let rest: TwilioRest | undefined = deps.rest;
    const ctx: WebhookContext = {
      params,
      appBaseUrl: env.APP_BASE_URL,
      admin: deps.adminClient ?? createAdminClient(),
      rest: () => (rest ??= createTwilioRest(env)),
      now: deps.now ? deps.now() : new Date(),
    };
    return twimlResponse(await handler(ctx));
  } catch (error) {
    logTwilioError("webhook_failed", error, { route, callSid: params.CallSid, from: params.From, to: params.To });
    return onError === "failure-twiml"
      ? twimlResponse(failureTwiml())
      : new Response("Internal Server Error", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

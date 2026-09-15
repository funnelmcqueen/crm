import "server-only";
import twilio from "twilio";
import type { ServerEnv } from "@/server/env";

export type TwilioParams = Record<string, string>;

export type WebhookValidation = { ok: true; params: TwilioParams } | { ok: false };

type SignatureEnv = Pick<ServerEnv, "APP_BASE_URL" | "TWILIO_AUTH_TOKEN" | "TWILIO_ACCOUNT_SID">;

/** The URL Twilio signed: the public origin (never the proxied host) plus the request path and query. */
export function twilioSignedUrl(req: Request, appBaseUrl: string): string {
  const url = new URL(req.url);
  return `${appBaseUrl.replace(/\/+$/, "")}${url.pathname}${url.search}`;
}

async function readFormParams(req: Request): Promise<TwilioParams | null> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) return null;
  try {
    const form = await req.formData();
    const params: TwilioParams = {};
    for (const [key, value] of form.entries()) {
      if (typeof value !== "string") return null;
      params[key] = value;
    }
    return params;
  } catch {
    return null;
  }
}

/**
 * Validates X-Twilio-Signature against APP_BASE_URL + path + query and requires the configured
 * AccountSid. Missing configuration never validates.
 */
export async function validateTwilioWebhook(req: Request, env: SignatureEnv): Promise<WebhookValidation> {
  const authToken = env.TWILIO_AUTH_TOKEN;
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const baseUrl = env.APP_BASE_URL;
  if (!authToken || !accountSid || !baseUrl) return { ok: false };

  const signature = req.headers.get("x-twilio-signature");
  if (!signature) return { ok: false };

  const params = await readFormParams(req);
  if (params === null) return { ok: false };

  let valid = false;
  try {
    valid = twilio.validateRequest(authToken, signature, twilioSignedUrl(req, baseUrl), params);
  } catch {
    valid = false;
  }
  if (!valid || params.AccountSid !== accountSid) return { ok: false };
  return { ok: true, params };
}

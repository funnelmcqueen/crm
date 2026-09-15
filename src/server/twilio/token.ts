import "server-only";
import twilio from "twilio";
import type { ServerEnv } from "@/server/env";

export const VOICE_TOKEN_TTL_SECONDS = 3600;

type TokenEnv = Pick<ServerEnv, "TWILIO_ACCOUNT_SID" | "TWILIO_API_KEY_SID" | "TWILIO_API_KEY_SECRET" | "TWILIO_TWIML_APP_SID">;

/** Access token for the browser Voice SDK. identity is the user id, which the outbound webhook re-checks. */
export function createVoiceAccessToken(env: TokenEnv, identity: string): { token: string; ttl: number } {
  const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID } = env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET || !TWILIO_TWIML_APP_SID) {
    throw new Error("Twilio is not configured");
  }
  const { AccessToken } = twilio.jwt;
  const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, {
    identity,
    ttl: VOICE_TOKEN_TTL_SECONDS,
  });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: TWILIO_TWIML_APP_SID, incomingAllow: true }));
  return { token: token.toJwt(), ttl: VOICE_TOKEN_TTL_SECONDS };
}

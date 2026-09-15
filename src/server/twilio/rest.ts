import "server-only";
import { z } from "zod";
import { isE164 } from "@/lib/domain/phone";
import type { ServerEnv } from "@/server/env";
import { ACCOUNT_SID_PATTERN, APPLICATION_SID_PATTERN, PHONE_NUMBER_SID_PATTERN, isCallSid, isRecordingSid } from "@/server/twilio/sids";

export interface TwilioIncomingNumber {
  sid: string;
  phoneNumber: string;
  voiceApplicationSid: string | null;
}

/** Everything the app asks of the Twilio REST API. Injected into route cores so tests never hit the network. */
export interface TwilioRest {
  /** The recording audio (mp3). Forwards `Range`; the caller streams the body. */
  fetchRecording(recordingSid: string, range?: string | null): Promise<Response>;
  /** The number in this account with exactly that E.164 value, or null. */
  findIncomingNumber(e164: string): Promise<TwilioIncomingNumber | null>;
  /** Points the number's voice handler at the TwiML App. */
  setIncomingNumberVoiceApp(numberSid: string, appSid: string): Promise<void>;
  /** The call's current status (e.g. `in-progress`, `completed`), or null when Twilio has no such call. */
  fetchCallStatus(callSid: string): Promise<string | null>;
}

export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

type RestEnv = Pick<ServerEnv, "TWILIO_ACCOUNT_SID" | "TWILIO_API_KEY_SID" | "TWILIO_API_KEY_SECRET">;

const incomingNumbersSchema = z.object({
  incoming_phone_numbers: z.array(
    z.object({
      sid: z.string(),
      phone_number: z.string(),
      voice_application_sid: z.string().nullable().optional(),
    }),
  ),
});

const callStatusSchema = z.object({ status: z.string().min(1) });

/** Real client: plain fetch with API-key basic auth. */
export function createTwilioRest(env: RestEnv, fetchImpl: typeof fetch = fetch): TwilioRest {
  function credentials(): { accountSid: string; authorization: string } {
    const accountSid = env.TWILIO_ACCOUNT_SID;
    const keySid = env.TWILIO_API_KEY_SID;
    const keySecret = env.TWILIO_API_KEY_SECRET;
    if (!accountSid || !keySid || !keySecret || !ACCOUNT_SID_PATTERN.test(accountSid)) {
      throw new Error("Twilio is not configured");
    }
    return { accountSid, authorization: `Basic ${Buffer.from(`${keySid}:${keySecret}`).toString("base64")}` };
  }

  return {
    async fetchRecording(recordingSid, range) {
      if (!isRecordingSid(recordingSid)) throw new Error("invalid recording SID");
      const { accountSid, authorization } = credentials();
      const headers = new Headers({ Authorization: authorization });
      if (range) headers.set("Range", range);
      return fetchImpl(`${TWILIO_API_BASE}/Accounts/${accountSid}/Recordings/${recordingSid}.mp3`, { headers });
    },

    async findIncomingNumber(e164) {
      if (!isE164(e164)) return null;
      const { accountSid, authorization } = credentials();
      const query = new URLSearchParams({ PhoneNumber: e164, PageSize: "20" });
      const res = await fetchImpl(`${TWILIO_API_BASE}/Accounts/${accountSid}/IncomingPhoneNumbers.json?${query}`, {
        headers: { Authorization: authorization, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Twilio number lookup failed with HTTP ${res.status}`);
      const parsed = incomingNumbersSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error("Twilio number lookup returned an unexpected body");
      const match = parsed.data.incoming_phone_numbers.find(
        (n) => n.phone_number === e164 && PHONE_NUMBER_SID_PATTERN.test(n.sid),
      );
      return match ? { sid: match.sid, phoneNumber: match.phone_number, voiceApplicationSid: match.voice_application_sid ?? null } : null;
    },

    async setIncomingNumberVoiceApp(numberSid, appSid) {
      if (!PHONE_NUMBER_SID_PATTERN.test(numberSid) || !APPLICATION_SID_PATTERN.test(appSid)) {
        throw new Error("invalid number or application SID");
      }
      const { accountSid, authorization } = credentials();
      const res = await fetchImpl(`${TWILIO_API_BASE}/Accounts/${accountSid}/IncomingPhoneNumbers/${numberSid}.json`, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ VoiceApplicationSid: appSid }).toString(),
      });
      if (!res.ok) throw new Error(`Twilio number update failed with HTTP ${res.status}`);
    },

    async fetchCallStatus(callSid) {
      if (!isCallSid(callSid)) throw new Error("invalid call SID");
      const { accountSid, authorization } = credentials();
      const res = await fetchImpl(`${TWILIO_API_BASE}/Accounts/${accountSid}/Calls/${callSid}.json`, {
        headers: { Authorization: authorization, Accept: "application/json" },
      });
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!res.ok) throw new Error(`Twilio call lookup failed with HTTP ${res.status}`);
      const parsed = callStatusSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error("Twilio call lookup returned an unexpected body");
      return parsed.data.status;
    },
  };
}

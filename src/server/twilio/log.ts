import "server-only";
import { maskPhone } from "@/lib/domain/phone";

export type TwilioLogValue = string | number | boolean | null | undefined;

const PHONE_KEY = /from|to|phone|e164|caller|called|number|remote/i;
const PHONE_LIKE = /\+?\d[\d\s().-]{5,}\d/g;

function maskValue(key: string, value: TwilioLogValue): string {
  if (value === null || value === undefined) return String(value);
  const text = String(value);
  if (PHONE_KEY.test(key) && !text.startsWith("client:")) return maskPhone(text) || text;
  return text.replace(PHONE_LIKE, (match) => maskPhone(match));
}

/** One line per event. Phone numbers are always masked (ARCHITECTURE golden rule 10). */
export function formatTwilioLog(event: string, fields: Record<string, TwilioLogValue> = {}): string {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${maskValue(key, value)}`);
  return `[twilio] ${event}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}`;
}

export function logTwilioWarning(event: string, fields: Record<string, TwilioLogValue> = {}): void {
  console.warn(formatTwilioLog(event, fields));
}

export function logTwilioError(event: string, error: unknown, fields: Record<string, TwilioLogValue> = {}): void {
  const summary =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { code?: unknown }).code ?? "") + " " + String((error as { message: unknown }).message)
        : String(error);
  console.error(formatTwilioLog(event, { ...fields, error: summary }));
}

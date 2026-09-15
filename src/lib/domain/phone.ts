import { parsePhoneNumberFromString, type CountryCode, type PhoneNumber } from 'libphonenumber-js';

export type { CountryCode };

export type NormalizePhoneResult =
  | { ok: true; e164: string }
  | { ok: false; reason: 'empty' | 'invalid' };

/** Same pattern as the `leads.phone` / `phone_numbers.e164` CHECK constraints. */
export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

const MAX_INPUT_LENGTH = 100;
// NANP area codes and exchanges start with 2-9. libphonenumber's isPossible() only checks length.
const NANP_NATIONAL_NUMBER = /^[2-9]\d{2}[2-9]\d{6}$/;

function parse(input: string, defaultCountry: CountryCode): PhoneNumber | undefined {
  try {
    // extract: false demands that the whole string is a phone number (no "call 212-555-0100 now").
    return parsePhoneNumberFromString(input, { defaultCountry, extract: false });
  } catch {
    return undefined;
  }
}

/**
 * Normalizes user or CSV input to E.164. Extensions are dropped. Accepts numbers libphonenumber
 * considers *possible* (not necessarily assigned), so fictional 555-01XX numbers normalize.
 */
export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry: CountryCode = 'US',
): NormalizePhoneResult {
  if (raw === null || raw === undefined) return { ok: false, reason: 'empty' };
  const trimmed = String(raw).trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_INPUT_LENGTH) return { ok: false, reason: 'invalid' };

  const parsed = parse(trimmed.replace(/^tel:/i, ''), defaultCountry);
  if (!parsed || !parsed.isPossible()) return { ok: false, reason: 'invalid' };

  const e164: string = parsed.number;
  if (!E164_PATTERN.test(e164)) return { ok: false, reason: 'invalid' };
  if (parsed.countryCallingCode === '1' && !NANP_NATIONAL_NUMBER.test(parsed.nationalNumber)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, e164 };
}

export function isE164(value: unknown): value is string {
  return typeof value === 'string' && E164_PATTERN.test(value);
}

export function phoneDigits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

/** For logs: keeps the country calling code and the last 4 digits. `+12125550123` -> `+1******0123`. */
export function maskPhone(value: string | null | undefined): string {
  const digits = phoneDigits(value);
  if (digits.length === 0) return '';
  if (digits.length <= 4) return '*'.repeat(digits.length);

  const international = (value ?? '').trim().startsWith('+');
  let callingCode = '';
  if (international) {
    callingCode = parse(`+${digits}`, 'US')?.countryCallingCode ?? '';
    if (digits.length - callingCode.length < 4) callingCode = '';
  }
  const hidden = digits.length - callingCode.length - 4;
  return `${international ? '+' : ''}${callingCode}${'*'.repeat(hidden)}${digits.slice(-4)}`;
}

/** `+12125550100` -> `(212) 555-0100`; other countries use international format. */
export function formatPhoneDisplay(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const parsed = parse(trimmed, 'US');
  if (!parsed || !parsed.isPossible()) return trimmed;
  return parsed.countryCallingCode === '1' ? parsed.formatNational() : parsed.formatInternational();
}

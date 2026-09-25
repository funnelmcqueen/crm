import type { Locale } from "@/lib/i18n/locales";
import en from "@/lib/i18n/messages/en/workspace";
import de from "@/lib/i18n/messages/de/workspace";

export type LocalizableAppErrorCode = keyof typeof en.appErrors;

const messages = { en: en.appErrors, de: de.appErrors };

/** Return a safe display message for the standard action error codes. */
export function getAppErrorMessage(code: unknown, locale: Locale, englishMessage?: string): string {
  if (!isLocalizableAppErrorCode(code)) return messages[locale].internal;
  if (locale === "en" && englishMessage?.trim()) return englishMessage;
  return messages[locale][code];
}

function isLocalizableAppErrorCode(code: unknown): code is LocalizableAppErrorCode {
  return typeof code === "string" && Object.hasOwn(en.appErrors, code);
}

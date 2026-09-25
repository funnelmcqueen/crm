import type { Locale } from "@/lib/i18n/locales";
import type { AppErrorCode } from "@/server/errors";
import en from "@/lib/i18n/messages/en/workspace";
import de from "@/lib/i18n/messages/de/workspace";
import enAdmin from "@/lib/i18n/messages/en/admin";
import deAdmin from "@/lib/i18n/messages/de/admin";

export type LocalizableAppErrorCode = AppErrorCode;
export type CreateAgentWarning = "profile_settings_save_failed" | "calendar_not_connected" | "calendar_provision_failed";

const createAgentWarningMessages: Record<Locale, Record<CreateAgentWarning, string>> = {
  en: {
    profile_settings_save_failed: enAdmin["The account was created, but its daily target, time zone and language could not be saved. Edit the agent to set them."],
    calendar_not_connected: enAdmin["The account was created, but Google Calendar isn't connected, so they can't book meetings yet."],
    calendar_provision_failed: enAdmin["The account was created, but their meetings calendar could not be. Give them one from Settings."],
  },
  de: {
    profile_settings_save_failed: deAdmin["The account was created, but its daily target, time zone and language could not be saved. Edit the agent to set them."],
    calendar_not_connected: deAdmin["The account was created, but Google Calendar isn't connected, so they can't book meetings yet."],
    calendar_provision_failed: deAdmin["The account was created, but their meetings calendar could not be. Give them one from Settings."],
  },
};

export function getCreateAgentWarningMessage(code: CreateAgentWarning, locale: Locale): string {
  return createAgentWarningMessages[locale][code];
}

const messages: Record<Locale, Record<LocalizableAppErrorCode, string>> = {
  en: en.appErrors,
  de: de.appErrors,
};

/** Return a safe display message for the standard action error codes. */
export function getAppErrorMessage(code: unknown, locale: Locale, englishMessage?: string): string {
  if (!isLocalizableAppErrorCode(code)) return messages[locale].internal;
  if (locale === "en" && englishMessage?.trim()) return englishMessage;
  return messages[locale][code];
}

function isLocalizableAppErrorCode(code: unknown): code is LocalizableAppErrorCode {
  return typeof code === "string" && Object.hasOwn(en.appErrors, code);
}

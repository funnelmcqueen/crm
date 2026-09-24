import type { Locale } from "./locales";

const localeTag = (locale: Locale) => (locale === "de" ? "de-DE" : "en-US");

export function formatNumber(value: number, locale: Locale, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(localeTag(locale), options).format(value);
}

export function formatDate(value: Date, locale: Locale, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(localeTag(locale), options ?? { dateStyle: "short", timeZone: "UTC" }).format(value);
}

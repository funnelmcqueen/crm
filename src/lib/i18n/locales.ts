export const LOCALES = ["en", "de"] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "de";
}

export function resolveLocale(cookieLocale: unknown, profileLocale?: unknown): Locale {
  if (isLocale(cookieLocale)) return cookieLocale;
  if (isLocale(profileLocale)) return profileLocale;
  return "en";
}

"use server";

import { cookies } from "next/headers";
import { isLocale, type Locale } from "@/lib/i18n/locales";

export async function setLocale(locale: Locale | null): Promise<void> {
  if (locale !== null && !isLocale(locale)) throw new Error("Unsupported locale");
  const store = await cookies();
  if (locale === null) {
    store.set("crm_locale", "", { httpOnly: true, path: "/", sameSite: "lax", maxAge: 0 });
    return;
  }
  store.set("crm_locale", locale, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
}

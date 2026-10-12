// Server-only: it reads the request cookies and the caller's profile, so it cannot live under
// src/lib/** — that tree may be bundled for the browser (ARCHITECTURE golden rule 7).
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { requireUserPage } from "@/server/context";
import { resolveLocale } from "@/lib/i18n/locales";

/** Match the app shell's cookie/profile precedence for browser tab titles. */
export async function appPageMetadata(english: string, german: string): Promise<Metadata> {
  const ctx = await requireUserPage();
  const locale = resolveLocale((await cookies()).get("crm_locale")?.value, ctx.profile.primary_locale);
  return { title: locale === "de" ? german : english };
}

export async function publicPageMetadata(english: string, german: string): Promise<Metadata> {
  const locale = resolveLocale((await cookies()).get("crm_locale")?.value);
  return { title: locale === "de" ? german : english };
}

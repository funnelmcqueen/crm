import type { Metadata } from "next";
import { cookies } from "next/headers";
import { requireUserPage } from "@/server/context";
import { resolveLocale } from "./locales";

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

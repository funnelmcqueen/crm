import { cookies } from "next/headers";
import { resolveLocale } from "./locales";
import en from "./messages/en/workspace";
import de from "./messages/de/workspace";

export async function getServerWorkspace(profileLocale: unknown) {
  const locale = resolveLocale((await cookies()).get("crm_locale")?.value, profileLocale);
  return { locale, t: locale === "de" ? de : en };
}

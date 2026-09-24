"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import en from "@/lib/i18n/messages/en/core";
import de from "@/lib/i18n/messages/de/core";
import workspaceEn from "@/lib/i18n/messages/en/workspace";
import workspaceDe from "@/lib/i18n/messages/de/workspace";
import type { Locale } from "@/lib/i18n/locales";

const messages = { en, de };
type Messages = typeof en;
const LocaleContext = createContext<{ locale: Locale; messages: Messages }>({ locale: "en", messages: en });

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return <LocaleContext.Provider value={{ locale, messages: messages[locale] }}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  return useContext(LocaleContext);
}

const workspaceMessages = { en: workspaceEn, de: workspaceDe };

/** Typed messages for the sales workspace, selected by the existing locale provider. */
export function useTranslations(namespace: "workspace") {
  const { locale } = useLocale();
  if (namespace === "workspace") return workspaceMessages[locale];
  return workspaceMessages[locale];
}

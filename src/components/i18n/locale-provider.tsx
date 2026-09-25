"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import en from "@/lib/i18n/messages/en/core";
import de from "@/lib/i18n/messages/de/core";
import workspaceEn from "@/lib/i18n/messages/en/workspace";
import workspaceDe from "@/lib/i18n/messages/de/workspace";
import operationsEn from "@/lib/i18n/messages/en/operations";
import operationsDe from "@/lib/i18n/messages/de/operations";
import adminEn from "@/lib/i18n/messages/en/admin";
import adminDe from "@/lib/i18n/messages/de/admin";
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

const operationsMessages = { en: operationsEn, de: operationsDe };
const adminMessages = { en: adminEn, de: adminDe };

/** Typed messages for the sales workspace, selected by the existing locale provider. */
export function useTranslations(namespace: "admin"): typeof adminEn;
export function useTranslations(namespace: "operations"): typeof operationsEn;
export function useTranslations(namespace: "workspace"): typeof workspaceEn;
export function useTranslations(namespace: "workspace" | "operations" | "admin") {
  const { locale } = useLocale();
  if (namespace === "workspace") return workspaceMessages[locale];
  if (namespace === "operations") return operationsMessages[locale];
  return adminMessages[locale];
}

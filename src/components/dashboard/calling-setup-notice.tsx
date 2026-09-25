"use client";

import { Info, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import type { Locale } from "@/lib/i18n/locales";
import { useDialer } from "@/components/dialer/dialer-context";
import { useCallModePreference } from "@/lib/dialer/preference";
import type { DialerDriverName } from "@/lib/dialer/types";
import { cn } from "@/lib/utils";

export interface CallingSetupNoticeProps {
  driver: DialerDriverName;
  inAppEnabled: boolean;
  callerIdAvailable: boolean;
  isAdmin: boolean;
}

interface Notice {
  tone: "warning" | "info";
  title: string;
  body: string;
  href: string | null;
  cta: string | null;
}

/**
 * Tells the caller, before they tap CALL, when calling is not set up the way they expect (DEVIATIONS D43). Reads
 * only what the app already knows: the server's dialer driver, the agent's in-app flag, whether a caller ID number
 * is available, and the dialer's live state in this browser. Never changes any calling configuration.
 */
export function CallingSetupNotice({ driver, inAppEnabled, callerIdAvailable, isAdmin }: CallingSetupNoticeProps) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const dialer = useDialer();
  const [preference] = useCallModePreference();
  const notice = pickNotice({
    driver,
    inAppEnabled,
    callerIdAvailable,
    isAdmin,
    wantsInApp: preference !== "phone",
    deviceReady: dialer?.deviceReady ?? false,
    connecting: dialer?.connecting ?? false,
  }, locale);
  if (!notice) return null;

  const Icon = notice.tone === "warning" ? TriangleAlert : Info;
  return (
    <section
      aria-label={t.setup}
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4 text-sm sm:flex-row sm:items-center",
        notice.tone === "warning" ? "border-gold/50 bg-gold/10" : "bg-card",
      )}
    >
      <Icon aria-hidden className={cn("hidden size-5 shrink-0 sm:block", notice.tone === "warning" ? "text-gold" : "text-muted-foreground")} />
      <p className="min-w-0 flex-1">
        <span className="font-bold">{notice.title}</span> {notice.body}
      </p>
      {notice.href && notice.cta ? (
        <Link
          href={notice.href}
          className="inline-flex min-h-12 shrink-0 items-center justify-center rounded-xl border bg-card px-4 font-bold outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {notice.cta}
        </Link>
      ) : null}
    </section>
  );
}

export interface SetupState {
  driver: DialerDriverName;
  inAppEnabled: boolean;
  callerIdAvailable: boolean;
  isAdmin: boolean;
  /** The caller's call mode is not "Always phone". */
  wantsInApp: boolean;
  deviceReady: boolean;
  connecting: boolean;
}

/** The single most important calling-setup message, or null when calling is ready. Exported for tests. */
export function pickNotice(state: SetupState, locale: Locale = "en"): Notice | null {
  // Phone-only deployments and agents set to phone calls dial from their own phone: nothing to set up.
  if (state.driver === "tel" || !state.wantsInApp) return null;
  if (!state.inAppEnabled) {
    return {
      tone: "info",
      title: locale === "de" ? "Anrufe öffnen deine Telefon-App." : "Calls open your phone app.",
      body: locale === "de" ? "Anrufe in der App sind für dein Konto deaktiviert. ANRUFEN wählt über dein Telefon." : "In-app calling is turned off for your account, so CALL dials from your own phone.",
      href: null,
      cta: null,
    };
  }
  if (!state.callerIdAvailable) {
    return state.isAdmin
      ? {
          tone: "warning",
          title: locale === "de" ? "Für Anrufe in der App ist keine Telefonnummer verfügbar." : "No phone number is available for in-app calls.",
          body: locale === "de" ? "Füge eine aktive Nummer hinzu oder weise eine zu, damit Anrufe verbunden werden können." : "Add or assign an active number so calls from the app can connect.",
          href: "/admin/phone-numbers",
          cta: locale === "de" ? "Telefonnummern" : "Phone numbers",
        }
      : {
          tone: "warning",
          title: locale === "de" ? "Für deine Anrufe in der App ist keine Telefonnummer eingerichtet." : "No phone number is set up for your in-app calls.",
          body: locale === "de" ? "Bitte deinen Administrator um eine Zuweisung. Bis dahin kannst du in den Einstellungen den Anrufmodus „Telefon“ wählen." : "Ask your admin to assign one. Until then, switch Call mode to phone in Settings to keep calling.",
          href: "/settings",
          cta: locale === "de" ? "Einstellungen" : "Settings",
        };
  }
  if (!state.deviceReady && !state.connecting) {
    return {
      tone: "info",
      title: locale === "de" ? "Anrufe in der App sind nicht verbunden." : "In-app calling isn't connected.",
      body: locale === "de" ? "ANRUFEN öffnet derzeit deine Telefon-App. Prüfe Mikrofon und Verbindung oder wähle in den Einstellungen einen Anrufmodus." : "CALL opens your phone app for now. Check your microphone and connection, or pick a call mode in Settings.",
      href: "/settings",
      cta: locale === "de" ? "Einstellungen" : "Settings",
    };
  }
  return null;
}

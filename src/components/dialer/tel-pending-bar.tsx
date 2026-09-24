"use client";

import { Phone, X } from "lucide-react";
import { useTranslations } from "@/components/i18n/locale-provider";

export interface TelPendingBarProps {
  label: string;
  onLogOutcome(): void;
  onDismiss(): void;
}

/** Fallback when returning from the phone app did not open the outcome sheet by itself. */
export function TelPendingBar({ label, onLogOutcome, onDismiss }: TelPendingBarProps) {
  const t = useTranslations("workspace");
  return (
    <section
      aria-label={t.phoneCallInProgress}
      className="fixed inset-x-0 bottom-[var(--bottom-nav-height)] z-40 border-t bg-card shadow-lg md:left-60"
    >
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-2 md:px-8">
        <Phone aria-hidden className="size-5 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-sm font-semibold">
          <span className="text-muted-foreground">{t.callingOnPhonePrefix}</span>
          <span className="font-extrabold text-foreground">{label}</span>
          <span className="text-muted-foreground">{t.callingOnPhoneSuffix}</span>
        </p>
        <button
          type="button"
          onClick={onLogOutcome}
          className="inline-flex min-h-12 shrink-0 items-center rounded-xl bg-primary px-4 text-sm font-extrabold text-primary-foreground outline-none transition-colors duration-150 hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {t.logOutcome}
        </button>
        <button
          type="button"
          aria-label={t.dismissWithoutLogging}
          onClick={onDismiss}
          className="inline-flex size-12 shrink-0 items-center justify-center rounded-xl text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <X aria-hidden className="size-5" />
        </button>
      </div>
    </section>
  );
}

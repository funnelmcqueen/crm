"use client";

import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { Skeleton } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  return (
    <div role="status" aria-label={locale === "de" ? "Einstellungen wird geladen" : "Loading settings"} className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Skeleton className="mb-2 h-8 w-32" />
      {[3, 1, 3, 2].map((rows, i) => (
        <div key={i} className="flex flex-col gap-4 rounded-xl border bg-card p-4 md:p-5">
          <Skeleton className="h-6 w-28" />
          {Array.from({ length: rows }, (_, j) => (
            <div key={j} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-12 w-full" />
            </div>
          ))}
        </div>
      ))}
      <span className="sr-only">{t.loading}</span>
    </div>
  );
}

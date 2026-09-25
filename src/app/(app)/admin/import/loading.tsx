"use client";

import { useTranslations } from "@/components/i18n/locale-provider";
import { Skeleton } from "@/components/ui/skeleton";

export default function ImportLeadsLoading() {
  const t = useTranslations("admin");
  return (
    <div role="status" aria-label={t["Loading import"]}>
      <div className="mb-6 flex flex-col gap-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="mb-6 flex gap-1">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-1 w-full" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
      <span className="sr-only">{t["Loading…"]}</span>
    </div>
  );
}

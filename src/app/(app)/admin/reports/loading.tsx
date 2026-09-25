"use client";

import { useTranslations } from "@/components/i18n/locale-provider";
import { Skeleton } from "@/components/ui/skeleton";

export default function ReportsLoading() {
  const t = useTranslations("admin");
  return (
    <div role="status" aria-label={t["Loading reports"]}>
      <div className="mb-6 flex flex-col gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-44" />
      </div>

      <div className="mb-3 flex gap-2 overflow-hidden">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-28 shrink-0" />
        ))}
      </div>
      <div className="mb-6 flex flex-wrap gap-2">
        <Skeleton className="h-12 w-40" />
        <Skeleton className="h-12 w-40" />
        <Skeleton className="h-12 w-24" />
      </div>

      <Skeleton className="mb-2 h-3 w-24" />
      <div className="mb-8 grid grid-cols-2 gap-px overflow-hidden rounded-xl border sm:grid-cols-4 xl:grid-cols-8">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2 bg-card px-4 py-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-7 w-12" />
          </div>
        ))}
      </div>

      <Skeleton className="mb-2 h-3 w-20" />
      <div className="mb-8 overflow-hidden rounded-xl border bg-card">
        <Skeleton className="h-11 w-full rounded-none" />
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex h-12 items-center gap-6 border-t px-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="ml-auto h-4 w-10" />
            <Skeleton className="h-4 w-10" />
            <Skeleton className="h-4 w-10" />
          </div>
        ))}
      </div>
      <span className="sr-only">{t["Loading…"]}</span>
    </div>
  );
}

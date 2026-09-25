"use client";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { formatNumber } from "@/lib/i18n/format";
import { leadListHref, type LeadListParams, type PageWindow } from "./list-params";

export interface LeadsPaginationProps {
  params: LeadListParams;
  window: PageWindow;
}

export function LeadsPagination({ params, window }: LeadsPaginationProps) {
  const { locale } = useLocale();
  const t = useTranslations("workspace").pagination;
  const fmt = (n: number) => formatNumber(n, locale);
  const { page, pageCount, total, from, to } = window;
  const hasPrev = page > 1;
  const hasNext = page < pageCount;
  if (total === 0) return null;

  return (
    <nav aria-label={t.navigation} className="mt-4 flex items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {from > 0 ? (
          <>
            {t.showing}{" "}
            <span className="font-extrabold text-foreground tabular-nums">
              {fmt(from)}–{fmt(to)}
            </span>{" "}
            {t.of} <span className="font-extrabold text-foreground tabular-nums">{fmt(total)}</span>
          </>
        ) : (
          <>
            <span className="font-extrabold text-foreground tabular-nums">{fmt(total)}</span> {t.leads}
          </>
        )}
      </p>
      <div className="flex items-center gap-2">
        {hasPrev ? (
          <Button asChild variant="outline" className="h-12 gap-1 px-3">
            <Link href={leadListHref({ ...params, page: Math.min(page - 1, pageCount) })} scroll={false} rel="prev">
              <ChevronLeft aria-hidden />
              {t.prev}
            </Link>
          </Button>
        ) : (
          <Button variant="outline" className="h-12 gap-1 px-3" disabled>
            <ChevronLeft aria-hidden />
            {t.prev}
          </Button>
        )}
        {hasNext ? (
          <Button asChild variant="outline" className="h-12 gap-1 px-3">
            <Link href={leadListHref({ ...params, page: page + 1 })} scroll={false} rel="next">
              {t.next}
              <ChevronRight aria-hidden />
            </Link>
          </Button>
        ) : (
          <Button variant="outline" className="h-12 gap-1 px-3" disabled>
            {t.next}
            <ChevronRight aria-hidden />
          </Button>
        )}
      </div>
    </nav>
  );
}

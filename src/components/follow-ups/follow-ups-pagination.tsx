import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import type { PageWindow } from "@/components/leads/list-params";
import { Button } from "@/components/ui/button";
import { followUpsHref, type FollowUpTab } from "./params";

export interface FollowUpsPaginationProps {
  tab: FollowUpTab;
  window: PageWindow;
}

export function FollowUpsPagination({ tab, window }: FollowUpsPaginationProps) {
  const t = useTranslations("workspace").queueList;
  const { locale } = useLocale();
  const fmt = (n: number) => n.toLocaleString(locale === "de" ? "de-DE" : "en-US");
  const { page, pageCount, total, from, to } = window;
  if (total === 0 || pageCount <= 1) return null;
  const hasPrev = page > 1;
  const hasNext = page < pageCount;

  return (
    <nav aria-label={t.pagination} className="mt-4 flex flex-wrap items-center justify-between gap-3">
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
            <span className="font-extrabold text-foreground tabular-nums">{fmt(total)}</span> {t.inTotal}
          </>
        )}
      </p>
      <div className="flex items-center gap-2">
        {hasPrev ? (
          <Button asChild variant="outline" className="h-12 gap-1 px-3">
            <Link href={followUpsHref(tab, Math.min(page - 1, pageCount))} scroll={false} rel="prev">
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
            <Link href={followUpsHref(tab, page + 1)} scroll={false} rel="next">
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

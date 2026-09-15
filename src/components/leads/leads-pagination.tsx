import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { leadListHref, type LeadListParams, type PageWindow } from "./list-params";

export interface LeadsPaginationProps {
  params: LeadListParams;
  window: PageWindow;
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function LeadsPagination({ params, window }: LeadsPaginationProps) {
  const { page, pageCount, total, from, to } = window;
  const hasPrev = page > 1;
  const hasNext = page < pageCount;
  if (total === 0) return null;

  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {from > 0 ? (
          <>
            Showing{" "}
            <span className="font-extrabold text-foreground tabular-nums">
              {fmt(from)}–{fmt(to)}
            </span>{" "}
            of <span className="font-extrabold text-foreground tabular-nums">{fmt(total)}</span>
          </>
        ) : (
          <>
            <span className="font-extrabold text-foreground tabular-nums">{fmt(total)}</span> leads
          </>
        )}
      </p>
      <div className="flex items-center gap-2">
        {hasPrev ? (
          <Button asChild variant="outline" className="h-12 gap-1 px-3">
            <Link href={leadListHref({ ...params, page: Math.min(page - 1, pageCount) })} scroll={false} rel="prev">
              <ChevronLeft aria-hidden />
              Prev
            </Link>
          </Button>
        ) : (
          <Button variant="outline" className="h-12 gap-1 px-3" disabled>
            <ChevronLeft aria-hidden />
            Prev
          </Button>
        )}
        {hasNext ? (
          <Button asChild variant="outline" className="h-12 gap-1 px-3">
            <Link href={leadListHref({ ...params, page: page + 1 })} scroll={false} rel="next">
              Next
              <ChevronRight aria-hidden />
            </Link>
          </Button>
        ) : (
          <Button variant="outline" className="h-12 gap-1 px-3" disabled>
            Next
            <ChevronRight aria-hidden />
          </Button>
        )}
      </div>
    </nav>
  );
}

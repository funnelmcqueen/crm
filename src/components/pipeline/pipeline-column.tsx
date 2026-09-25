"use client";

import { useDroppable } from "@dnd-kit/core";
import type { ReactNode } from "react";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { formatNumber } from "@/lib/i18n/format";
import { Button } from "@/components/ui/button";
import type { PipelineColumn } from "@/lib/domain/statuses";
import { cn } from "@/lib/utils";
import { PIPELINE_PAGE_SIZE_CLIENT } from "./constants";

export interface PipelineColumnViewProps {
  column: PipelineColumn;
  total: number;
  shown: number;
  loading: boolean;
  /** A drag is in progress somewhere on the board. */
  dragging: boolean;
  onLoadMore(): void;
  children: ReactNode;
}

export function PipelineColumnView({ column, total, shown, loading, dragging, onLoadMore, children }: PipelineColumnViewProps) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const stage = useTranslations("workspace").statuses[column.key];
  const { setNodeRef, isOver } = useDroppable({ id: column.key });
  const headingId = `pipeline-column-${column.key}`;
  const remaining = Math.max(0, total - shown);

  return (
    <section
      ref={setNodeRef}
      id={`pipeline-column-section-${column.key}`}
      aria-labelledby={headingId}
      data-column={column.key}
      className={cn(
        // md+: a bounded height with the cards scrolling inside, so the header and count stay visible and a very
        // long column never pushes the board's sideways scrollbar off the screen (DEVIATIONS D44).
        "flex w-[85vw] max-w-sm shrink-0 snap-start flex-col rounded-xl border bg-card/40 transition-colors duration-100 sm:w-80 md:max-h-[calc(100dvh-15rem)] md:min-h-72 md:w-64 xl:w-72",
        dragging && "border-dashed",
        isOver && "border-solid border-primary bg-primary/5",
        column.closed && "bg-transparent",
      )}
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
        <h2
          id={headingId}
          tabIndex={-1}
          className={cn("truncate rounded-sm text-sm font-bold outline-none focus-visible:ring-3 focus-visible:ring-ring/50", column.closed && "text-muted-foreground")}
        >
          {stage}
        </h2>
        <span className="text-sm font-extrabold tabular-nums" aria-label={`${formatNumber(total, locale)} ${total === 1 ? t.pipelineLead : t.pipelineLeads}`}>
          {formatNumber(total, locale)}
        </span>
      </header>

      <div className="flex min-h-32 flex-1 flex-col gap-2 p-2 md:min-h-0 md:overflow-y-auto">
        {shown === 0 ? (
          <p className="flex min-h-24 flex-1 items-center justify-center rounded-lg border border-dashed px-3 text-center text-xs text-muted-foreground">
            {dragging ? t.dropHere.replace("{stage}", stage) : t.noLeads}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">{children}</ul>
        )}

        {remaining > 0 ? (
          <Button variant="outline" className="h-12 w-full" disabled={loading} onClick={onLoadMore}>
            {loading ? t.loading : t.loadMore.replace("{count}", formatNumber(Math.min(remaining, PIPELINE_PAGE_SIZE_CLIENT), locale))}
            <span className="sr-only"> in {stage}</span>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

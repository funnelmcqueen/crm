"use client";

import { useDroppable } from "@dnd-kit/core";
import type { ReactNode } from "react";
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
  const { setNodeRef, isOver } = useDroppable({ id: column.key });
  const headingId = `pipeline-column-${column.key}`;
  const remaining = Math.max(0, total - shown);

  return (
    <section
      ref={setNodeRef}
      aria-labelledby={headingId}
      data-column={column.key}
      className={cn(
        "flex w-[85vw] max-w-sm shrink-0 snap-start flex-col rounded-xl border bg-card/40 transition-colors duration-100 sm:w-80 md:w-72",
        dragging && "border-dashed",
        isOver && "border-solid border-primary bg-primary/5",
        column.closed && "bg-transparent",
      )}
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
        <h2 id={headingId} className={cn("truncate text-sm font-bold", column.closed && "text-muted-foreground")}>
          {column.label}
        </h2>
        <span className="text-sm font-extrabold tabular-nums" aria-label={`${total} ${total === 1 ? "lead" : "leads"}`}>
          {total.toLocaleString("en-US")}
        </span>
      </header>

      <div className="flex min-h-32 flex-1 flex-col gap-2 p-2">
        {shown === 0 ? (
          <p className="flex min-h-24 flex-1 items-center justify-center rounded-lg border border-dashed px-3 text-center text-xs text-muted-foreground">
            {dragging ? `Drop here for ${column.label}` : "No leads"}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">{children}</ul>
        )}

        {remaining > 0 ? (
          <Button variant="outline" className="h-12 w-full" disabled={loading} onClick={onLoadMore}>
            {loading ? "Loading…" : `Load ${Math.min(remaining, PIPELINE_PAGE_SIZE_CLIENT)} more`}
            <span className="sr-only"> in {column.label}</span>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

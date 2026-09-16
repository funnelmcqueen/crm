"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PipelineColumn } from "@/lib/domain/statuses";
import { cn } from "@/lib/utils";

export interface StageNavItem {
  column: PipelineColumn;
  total: number;
}

export interface PipelineStageNavProps {
  stages: StageNavItem[];
  /** Column keys at least partly on screen. */
  visible: ReadonlySet<string>;
  canScrollBack: boolean;
  canScrollForward: boolean;
  onJump(key: string): void;
  onScroll(direction: -1 | 1): void;
}

/**
 * Every stage with its count, always in view above the board, so a long New column never hides the later stages
 * (docs/DEVIATIONS.md D44). Choosing a stage scrolls its column into view and moves focus to it. The arrows page
 * the board sideways; on phones the columns still swipe.
 */
export function PipelineStageNav({ stages, visible, canScrollBack, canScrollForward, onJump, onScroll }: PipelineStageNavProps) {
  return (
    <nav aria-label="Pipeline stages" className="mb-3 flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        className="hidden size-12 shrink-0 md:inline-flex"
        aria-label="Scroll to earlier stages"
        disabled={!canScrollBack}
        onClick={() => onScroll(-1)}
      >
        <ChevronLeft aria-hidden />
      </Button>

      {/* relative: the sr-only text inside must not widen the page (same trap as follow-up-tabs.tsx). */}
      <ul className="relative -mx-4 flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
        {stages.map(({ column, total }) => {
          const inView = visible.has(column.key);
          return (
            <li key={column.key} className="shrink-0">
              <button
                type="button"
                aria-controls={`pipeline-column-section-${column.key}`}
                onClick={() => onJump(column.key)}
                className={cn(
                  "inline-flex min-h-12 items-center gap-2 rounded-full border px-3 text-sm font-semibold whitespace-nowrap outline-none transition-colors duration-100 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50",
                  inView ? "border-foreground/40 bg-muted text-foreground" : "bg-card text-muted-foreground",
                  column.closed && "border-dashed",
                )}
              >
                {column.label}
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-background px-1.5 text-xs font-extrabold text-foreground tabular-nums">
                  {total.toLocaleString("en-US")}
                </span>
                <span className="sr-only">{total === 1 ? " lead" : " leads"}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <Button
        type="button"
        variant="outline"
        className="hidden size-12 shrink-0 md:inline-flex"
        aria-label="Scroll to later stages"
        disabled={!canScrollForward}
        onClick={() => onScroll(1)}
      >
        <ChevronRight aria-hidden />
      </Button>
    </nav>
  );
}

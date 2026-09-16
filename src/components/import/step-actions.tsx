import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Sticky, thumb-reachable action bar for a wizard step. Sits above the mobile tab bar. */
export function StepActions({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "sticky bottom-[calc(var(--bottom-nav-height)+0.75rem)] z-20 mt-6 flex flex-col-reverse gap-2 rounded-xl border bg-card p-3 sm:flex-row sm:items-center sm:justify-end",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Compact number with a label, for dense stat rows. */
export function StatCell({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="truncate text-xs font-semibold text-muted-foreground">{label}</span>
      <span className={cn("text-2xl font-extrabold tabular-nums", className)}>{value}</span>
    </div>
  );
}

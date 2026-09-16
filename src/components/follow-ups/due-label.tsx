import { DateTime } from "@/components/common/datetime";
import { cn } from "@/lib/utils";
import { describeDue } from "./due";

export interface DueLabelProps {
  dueAt: string;
  tz: string;
  /** Server render time, so server and client render the same relative label. */
  now: number;
  align?: "start" | "end";
  className?: string;
}

/** Due date/time in the viewer's time zone plus a relative label; overdue is highlighted and announced. */
export function DueLabel({ dueAt, tz, now, align = "start", className }: DueLabelProps) {
  const due = describeDue(dueAt, now, tz);
  const overdue = due?.tone === "overdue";
  return (
    <span className={cn("flex flex-col gap-0.5", align === "end" ? "items-end text-right" : "items-start", className)}>
      <DateTime value={dueAt} tz={tz} now={now} className={cn("text-sm whitespace-nowrap", overdue && "font-semibold text-destructive")} />
      {due ? (
        <span
          className={cn(
            "text-xs whitespace-nowrap",
            overdue ? "font-bold text-destructive" : due.tone === "today" ? "font-semibold text-foreground" : "text-muted-foreground",
          )}
        >
          {due.label}
        </span>
      ) : null}
    </span>
  );
}

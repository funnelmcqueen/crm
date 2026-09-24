import { STATUS_LABELS, STATUS_TONE, type LeadStatus, type StatusTone } from "@/lib/domain/statuses";
import { cn } from "@/lib/utils";

const PILL: Record<StatusTone, string> = {
  neutral: "border-border bg-muted/60 text-foreground",
  info: "border-border bg-muted/60 text-foreground",
  warning: "border-border bg-muted/60 text-foreground",
  success: "border-success/30 bg-success/10 text-foreground",
  gold: "border-gold bg-gold text-gold-foreground",
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
  muted: "border-border bg-transparent text-muted-foreground",
};

const DOT: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground",
  info: "bg-foreground",
  warning: "bg-gold",
  success: "bg-success",
  gold: "bg-gold-foreground",
  danger: "bg-destructive",
  muted: "bg-muted-foreground/60",
};

export interface StatusBadgeProps {
  status: LeadStatus;
  className?: string;
  label?: string;
}

/** Lead status pill. Labels and tones come from lib/domain/statuses only. */
export function StatusBadge({ status, className, label }: StatusBadgeProps) {
  const tone = STATUS_TONE[status];
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold whitespace-nowrap",
        PILL[tone],
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", DOT[tone])} />
      {label ?? STATUS_LABELS[status]}
    </span>
  );
}

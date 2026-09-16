import { cn } from "@/lib/utils";
import { targetPercent } from "./format";

export interface TargetBarProps {
  dials: number;
  target: number;
  hit: boolean;
  /** Accessible name, e.g. "Calls today for Alex Rivera". */
  label: string;
  size?: "thin" | "default";
  className?: string;
}

/** Calls-vs-target progress bar. Red while in progress, gold once the target is hit. */
export function TargetBar({ dials, target, hit, label, size = "default", className }: TargetBarProps) {
  const percent = hit ? 100 : targetPercent(dials, target);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(target, 0)}
      aria-valuenow={Math.min(dials, Math.max(target, 0))}
      aria-valuetext={target > 0 ? `${dials} of ${target} calls` : `${dials} calls, no target`}
      className={cn("w-full overflow-hidden rounded-full bg-muted", size === "thin" ? "h-1" : "h-2", className)}
    >
      <div
        data-hit={hit || undefined}
        className={cn("h-full rounded-full transition-[width] duration-150", hit ? "bg-gold" : "bg-primary")}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

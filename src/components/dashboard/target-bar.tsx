import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { formatNumber } from "@/lib/i18n/format";
import type { DailyGoal } from "@/lib/domain/daily-goal";
import { cn } from "@/lib/utils";

export interface TargetBarProps {
  goal: DailyGoal;
  /** Accessible name, e.g. "Calls today for Alex Rivera". */
  label: string;
  size?: "thin" | "default";
  className?: string;
}

/** Calls-vs-target progress bar from dailyGoal(). Red while in progress, gold once reached, empty with no target. */
export function TargetBar({ goal, label, size = "default", className }: TargetBarProps) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const n = (value: number) => formatNumber(value, locale);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={goal.target}
      aria-valuenow={Math.min(goal.dials, goal.target)}
      aria-valuetext={
        goal.hasTarget
          ? locale === "de"
            ? `${n(goal.dials)} von ${n(goal.target)} Anrufen${goal.reached ? ", Ziel erreicht" : `, noch ${n(goal.remaining)}`}`
            : `${n(goal.dials)} of ${n(goal.target)} ${t.calls}${goal.reached ? ", goal reached" : `, ${n(goal.remaining)} to go`}`
          : locale === "de" ? `${n(goal.dials)} Anrufe, kein Ziel` : `${n(goal.dials)} calls, no target`
      }
      className={cn("w-full overflow-hidden rounded-full bg-muted", size === "thin" ? "h-1" : "h-2", className)}
    >
      <div
        data-hit={goal.reached || undefined}
        className={cn("h-full rounded-full transition-[width] duration-150", goal.reached ? "bg-gold" : "bg-primary")}
        style={{ width: `${goal.percent}%` }}
      />
    </div>
  );
}

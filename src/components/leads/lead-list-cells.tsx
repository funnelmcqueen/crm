import { DateTime } from "@/components/common/datetime";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { cn } from "@/lib/utils";

export function locationLabel(city: string | null, state: string | null): string {
  return [city, state].filter((part): part is string => !!part && part.trim() !== "").join(", ");
}

export function isOverdue(value: string | null, now: number): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time < now;
}

export interface FollowUpCellProps {
  value: string | null;
  tz: string;
  now: number;
  className?: string;
}

/** Next follow-up in the viewer's time zone; overdue ones are highlighted and announced. */
export function FollowUpCell({ value, tz, now, className }: FollowUpCellProps) {
  const { locale } = useLocale();
  const t = useTranslations("workspace").leadList;
  const overdue = isOverdue(value, now);
  return (
    <span className={cn("inline-flex items-center gap-1.5", overdue && "font-semibold text-destructive", className)}>
      <DateTime value={value} tz={tz} now={now} locale={locale} />
      {overdue ? <span className="sr-only"> ({t.overdue})</span> : null}
    </span>
  );
}

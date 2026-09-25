"use client";

import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { formatDate, formatNumber } from "@/lib/i18n/format";
import { getAppErrorMessage } from "@/lib/i18n/app-error-message";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatMinutes, HOURS_GRANULARITY_MINUTES, validateBookableRanges, type BookableRange } from "@/lib/domain/bookable-hours";
import { saveBookableHoursAction } from "@/server/actions/calendar-connection";

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const MINUTES_PER_DAY = 24 * 60;
/** 00:00 through 24:00 on the half hour, matching the granularity `set_bookable_hours` enforces. */
const MINUTE_OPTIONS = Array.from({ length: MINUTES_PER_DAY / HOURS_GRANULARITY_MINUTES + 1 }, (_, i) => i * HOURS_GRANULARITY_MINUTES);

const SELECT_CLASS =
  "min-h-12 rounded-lg border border-input bg-background px-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 lg:text-sm";

interface RangeDraft {
  id: string;
  weekday: number;
  startsMinute: number;
  endsMinute: number;
}

let nextDraftId = 0;
function makeDraftId(): string {
  nextDraftId += 1;
  return `range-${nextDraftId}`;
}

function draftsFromHours(hours: readonly BookableRange[]): RangeDraft[] {
  return hours.map((range) => ({ id: makeDraftId(), ...range }));
}

function TimeSelect({ label, value, onChange }: { label: string; value: number; onChange(value: number): void }) {
  return (
    <select aria-label={label} className={SELECT_CLASS} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {MINUTE_OPTIONS.map((minute) => (
        <option key={minute} value={minute}>
          {formatMinutes(minute)}
        </option>
      ))}
    </select>
  );
}

/** The bookable-hours editor (design §4, §9): one row per weekday, its ranges on the half hour, one Save for the week. */
export function BookableHoursForm({ hours }: { hours: BookableRange[] }) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const [drafts, setDrafts] = useState<RangeDraft[]>(() => draftsFromHours(hours));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function addRange(weekday: number) {
    setError(null);
    setDrafts((prev) => [...prev, { id: makeDraftId(), weekday, startsMinute: 540, endsMinute: 1020 }]);
  }

  function removeRange(id: string) {
    setError(null);
    setDrafts((prev) => prev.filter((draft) => draft.id !== id));
  }

  function updateRange(id: string, patch: Partial<Pick<RangeDraft, "startsMinute" | "endsMinute">>) {
    setError(null);
    setDrafts((prev) => prev.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
  }

  function submit() {
    const ranges: BookableRange[] = drafts
      .map(({ weekday, startsMinute, endsMinute }) => ({ weekday, startsMinute, endsMinute }))
      .sort((a, b) => a.weekday - b.weekday || a.startsMinute - b.startsMinute);
    const message = validateBookableRanges(ranges);
    if (message) {
      setError(locale === "de" ? ({ "Pick a day of the week.": "Wähle einen Wochentag.", "Times must be on the hour or the half hour.": "Zeiten müssen zur vollen oder halben Stunde beginnen.", "A start time must come before its end time.": "Der Beginn muss vor dem Ende liegen.", "Times must be between 00:00 and 24:00.": "Zeiten müssen zwischen 00:00 und 24:00 liegen.", "Two ranges on the same day overlap.": "Zwei Zeiträume am selben Tag überschneiden sich." } as Record<string, string>)[message] ?? message : message);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await saveBookableHoursAction(ranges);
      if (result.ok) {
        setDrafts(draftsFromHours(result.data));
        toast.success(t.hoursSaved);
      } else {
        setError(getAppErrorMessage(result.error.code, locale, result.error.message));
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {WEEKDAY_NAMES.map((englishName, weekday) => {
        const name = locale === "de" ? formatDate(new Date(Date.UTC(2024, 0, 7 + weekday)), locale, { weekday: "long", timeZone: "UTC" }) : englishName;
        const dayRanges = drafts.filter((draft) => draft.weekday === weekday).sort((a, b) => a.startsMinute - b.startsMinute);
        return (
          <div key={weekday} className="flex flex-col gap-2">
            <h4 className="text-sm font-bold">{name}</h4>
            {dayRanges.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.closed}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {dayRanges.map((range, index) => (
                  <li key={range.id} className="flex flex-wrap items-center gap-2">
                    <span className="text-sm tabular-nums">
                      {formatMinutes(range.startsMinute)} – {formatMinutes(range.endsMinute)}
                    </span>
                    <TimeSelect
                      label={locale === "de" ? `${name}, Zeitraum ${formatNumber(index + 1, locale)}, Beginn` : `${name} range ${index + 1} start`}
                      value={range.startsMinute}
                      onChange={(value) => updateRange(range.id, { startsMinute: value })}
                    />
                    <TimeSelect
                      label={locale === "de" ? `${name}, Zeitraum ${formatNumber(index + 1, locale)}, Ende` : `${name} range ${index + 1} end`}
                      value={range.endsMinute}
                      onChange={(value) => updateRange(range.id, { endsMinute: value })}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-12"
                      aria-label={locale === "de" ? `Zeitraum ${formatNumber(index + 1, locale)} am ${name} entfernen` : `Remove ${name} range ${index + 1}`}
                      onClick={() => removeRange(range.id)}
                    >
                      {t.remove}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <Button type="button" variant="outline" className="min-h-12" onClick={() => addRange(weekday)}>
                {t.addRange}
              </Button>
            </div>
          </div>
        );
      })}
      <p role="alert" aria-live="polite" className="min-h-5 text-sm font-semibold text-destructive">
        {error ?? ""}
      </p>
      <div>
        <Button type="button" className="min-h-12 font-bold" disabled={pending} onClick={submit}>
          {pending ? t.saving : t.saveHours}
        </Button>
      </div>
    </div>
  );
}

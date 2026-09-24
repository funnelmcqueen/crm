"use client";

import { CalendarClock } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { DateTime } from "@/components/common/datetime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { followUpQuickPicks, tryZonedLocalInputToUtc, utcToZonedLocalInput } from "@/lib/domain/time";
import { cn } from "@/lib/utils";
import { setNextFollowUpAction } from "@/server/actions/leads";
import { isOverdue } from "./lead-list-cells";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { formatDate } from "@/lib/i18n/format";

const MAX_NOTE = 500;

type QuickPick = "tomorrow9am" | "in3Days" | "nextWeek";

const QUICK_PICKS: ReadonlyArray<{ key: QuickPick; label: string }> = [
  { key: "tomorrow9am", label: "Tomorrow 9am" },
  { key: "in3Days", label: "In 3 days" },
  { key: "nextWeek", label: "Next week" },
];

export interface FollowUpPickerProps {
  leadId: string;
  nextFollowUpAt: string | null;
  /** The viewer's profile time zone; quick picks and the custom input use it. */
  tz: string;
  /** Server render time, so the first client render matches. */
  now: number;
}

export function FollowUpPicker({ leadId, nextFollowUpAt, tz, now }: FollowUpPickerProps) {
  const t = useTranslations("workspace");
  const { locale } = useLocale();
  const [pending, startTransition] = useTransition();
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const overdue = isOverdue(nextFollowUpAt, now);

  function save(due: Date) {
    setError(null);
    startTransition(async () => {
      const result = await setNextFollowUpAction(leadId, due.toISOString(), note.trim() === "" ? undefined : note);
      if (result.ok) {
        toast.success(t.followUpSetFor.replace("{date}", formatDate(due, locale, { dateStyle: "medium", timeStyle: "short", timeZone: tz })));
        setNote("");
        setCustom("");
        setCustomOpen(false);
      } else {
        setError(result.error.message);
      }
    });
  }

  function saveCustom() {
    const due = tryZonedLocalInputToUtc(custom, tz);
    if (!due) {
      setError(t.pickDateTime);
      return;
    }
    save(due);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t.nextFollowUp}</span>
        <p className={cn("flex items-center gap-2 text-base font-bold", overdue && "text-destructive")}>
          <CalendarClock aria-hidden className="size-5 shrink-0" />
          <DateTime value={nextFollowUpAt} tz={tz} now={now} empty={t.noneScheduled} locale={locale} />
          {overdue ? <span className="text-xs font-semibold uppercase">{t.overdue}</span> : null}
        </p>
      </div>

      <div role="group" aria-label={t.scheduleFollowUp} className="grid grid-cols-2 gap-2">
        {QUICK_PICKS.map((pick) => (
          <Button
            key={pick.key}
            type="button"
            variant="outline"
            disabled={pending}
            className="h-12"
            onClick={() => save(followUpQuickPicks(tz)[pick.key])}
          >
            {t.followUpPicks[pick.key === "tomorrow9am" ? "tomorrow" : pick.key === "in3Days" ? "in3days" : "nextWeek"]}
          </Button>
        ))}
        <Button
          type="button"
          variant={customOpen ? "secondary" : "outline"}
          disabled={pending}
          aria-expanded={customOpen}
          aria-controls="follow-up-custom"
          className="h-12"
          onClick={() => setCustomOpen((open) => !open)}
        >
          {t.followUpPicks.custom}
        </Button>
      </div>

      {customOpen ? (
        <div id="follow-up-custom" className="flex flex-col gap-2">
          <Label htmlFor="follow-up-custom-input" className="text-xs text-muted-foreground">
            {t.dateAndTime.replace("{zone}", tz.replace(/_/g, " "))}
          </Label>
          <div className="flex gap-2">
            <Input
              id="follow-up-custom-input"
              type="datetime-local"
              value={custom}
              min={utcToZonedLocalInput(now, tz)}
              onChange={(event) => setCustom(event.target.value)}
              className="h-12 flex-1 text-base lg:text-sm"
            />
            <Button type="button" disabled={pending || custom === ""} className="h-12 font-bold" onClick={saveCustom}>
              {t.set}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="follow-up-note" className="text-xs text-muted-foreground">
          {t.noteOptional}
        </Label>
        <Input
          id="follow-up-note"
          value={note}
          maxLength={MAX_NOTE}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t.followUpPlaceholder}
          className="h-12 text-base lg:text-sm"
        />
      </div>

      <p aria-live="polite" className="text-xs text-destructive">
        {error ?? (pending ? <span className="text-muted-foreground">{t.saving}</span> : "")}
      </p>
    </div>
  );
}

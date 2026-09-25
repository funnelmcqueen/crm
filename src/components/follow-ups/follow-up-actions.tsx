"use client";

import { CalendarClock, Check, ChevronDown } from "lucide-react";
import { useId, useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { getAppErrorMessage } from "@/lib/i18n/app-error-message";
import { formatDate } from "@/lib/i18n/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { followUpQuickPicks, utcToZonedLocalInput, type FollowUpQuickPicks } from "@/lib/domain/time";
import { cn } from "@/lib/utils";
import { rescheduleFollowUpAction } from "@/server/actions/follow-ups";
import type { RescheduleChoice, RescheduleQuickPick } from "@/server/services/follow-ups";

const QUICK_PICKS: ReadonlyArray<{ key: RescheduleQuickPick; label: string }> = [
  { key: "tomorrow9am", label: "Tomorrow 9am" },
  { key: "in3Days", label: "In 3 days" },
  { key: "nextWeek", label: "Next week" },
];

export interface CompleteButtonProps {
  businessName: string;
  onComplete(): void;
  className?: string;
}

export function CompleteButton({ businessName, onComplete, className }: CompleteButtonProps) {
  const t = useTranslations("workspace").queues;
  return (
    <Button
      type="button"
      variant="outline"
      aria-label={t.completeFor.replace("{name}", businessName)}
      className={cn("h-12 gap-1.5 px-3 font-semibold", className)}
      onClick={onComplete}
    >
      <Check aria-hidden />
      {t.complete}
    </Button>
  );
}

export interface RescheduleMenuProps {
  followUpId: string;
  businessName: string;
  /** The viewer's profile time zone (the server resolves the same choice in it). */
  tz: string;
  className?: string;
}

export function RescheduleMenu({ followUpId, businessName, tz, className }: RescheduleMenuProps) {
  const t = useTranslations("workspace").queues;
  const details = useTranslations("workspace").queueList;
  const { locale } = useLocale();
  const localizedDate = (value: string | Date) => formatDate(new Date(value), locale, { dateStyle: "medium", timeStyle: "short", timeZone: tz });
  const [pending, startTransition] = useTransition();
  const [picks, setPicks] = useState<FollowUpQuickPicks | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [minLocal, setMinLocal] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  function submit(choice: RescheduleChoice, onDone?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await rescheduleFollowUpAction(followUpId, choice);
      if (result.ok) {
        toast.success(details.savedTo.replace("{date}", localizedDate(result.data.dueAt)));
        onDone?.();
      } else {
        const message = getAppErrorMessage(result.error.code, locale, result.error.message);
        setError(message);
        toast.error(message);
      }
    });
  }

  function openCustom() {
    const now = Date.now();
    setCustom(utcToZonedLocalInput(followUpQuickPicks(tz, now).tomorrow9am, tz));
    setMinLocal(utcToZonedLocalInput(now, tz));
    setError(null);
    setCustomOpen(true);
  }

  function onCustomSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (custom === "") {
      setError(t.pickDate);
      return;
    }
    submit({ kind: "custom", local: custom }, () => setCustomOpen(false));
  }

  return (
    <>
      <DropdownMenu
        modal={false}
        onOpenChange={(open) => {
          if (open) setPicks(followUpQuickPicks(tz));
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            aria-label={t.rescheduleFor.replace("{name}", businessName)}
            className={cn("h-12 gap-1.5 px-3 font-semibold", className)}
          >
            <CalendarClock aria-hidden />
            {pending ? t.saving : t.reschedule}
            <ChevronDown aria-hidden className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-60">
          {QUICK_PICKS.map((pick) => (
            <DropdownMenuItem
              key={pick.key}
              className="min-h-12 flex-col items-start justify-center gap-0 px-3"
              onSelect={() => submit({ kind: "quick", pick: pick.key })}
            >
              <span className="font-semibold">{{ tomorrow9am: t.tomorrow, in3Days: t.in3Days, nextWeek: t.nextWeek }[pick.key]}</span>
              {picks ? (
                <span className="text-xs text-muted-foreground tabular-nums">{localizedDate(picks[pick.key])}</span>
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="min-h-12 px-3 font-semibold" onSelect={openCustom}>
            {t.custom}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={customOpen} onOpenChange={(open) => !pending && setCustomOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{details.rescheduleTitle}</DialogTitle>
            <DialogDescription>
              {businessName}. {details.timesIn.replace("{zone}", tz.replace(/_/g, " "))}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onCustomSubmit} className="flex flex-col gap-3">
            <Label htmlFor={inputId}>{details.dateTime}</Label>
            <Input
              id={inputId}
              type="datetime-local"
              value={custom}
              min={minLocal}
              required
              onChange={(event) => setCustom(event.target.value)}
              aria-invalid={error ? true : undefined}
              className="h-12 text-base lg:text-sm"
            />
            <p aria-live="polite" className="min-h-4 text-xs text-destructive">
              {error ?? ""}
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" className="h-12 px-5" disabled={pending} onClick={() => setCustomOpen(false)}>
                {details.cancel}
              </Button>
              <Button type="submit" className="h-12 px-5 font-bold" disabled={pending || custom === ""}>
                {pending ? t.saving : details.save}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

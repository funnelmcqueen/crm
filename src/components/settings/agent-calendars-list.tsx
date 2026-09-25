"use client";

// Who can book, and a way to give a calendar to whoever cannot (docs/DEVIATIONS.md D48). Everyone gets their
// own calendar on the connected Google account: with their account when they are created, here when they
// predate the connection or their provisioning failed. Renders no calendar id — it would say nothing useful
// and belongs to the owner's account, not the page.
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { formatNumber } from "@/lib/i18n/format";
import { getAppErrorMessage } from "@/lib/i18n/app-error-message";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { provisionCalendarForAgentAction } from "@/server/actions/calendar-connection";
import type { AgentCalendarRow } from "@/server/services/calendar-connection";

export interface AgentCalendarsListProps {
  rows: AgentCalendarRow[];
  /** False hides the buttons: provisioning cannot work before an account is connected. */
  connected: boolean;
}

export function AgentCalendarsList({ rows, connected }: AgentCalendarsListProps) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const [current, setCurrent] = useState(rows);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function provision(row: AgentCalendarRow) {
    setPendingId(row.userId);
    startTransition(async () => {
      const result = await provisionCalendarForAgentAction(row.userId);
      if (result.ok) {
        setCurrent(result.data);
        toast.success(locale === "de" ? `${row.name} kann jetzt Termine buchen.` : `${row.name} can book meetings now.`);
      } else {
        toast.error(getAppErrorMessage(result.error.code, locale, result.error.message));
      }
      setPendingId(null);
    });
  }

  const waiting = current.filter((row) => !row.hasCalendar);

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-bold">{t.whoCanBook}</h3>
      {waiting.length > 0 ? (
        <p role="alert" className="text-sm font-semibold text-destructive">
          {waiting.length === 1
            ? locale === "de" ? "1 Person hat noch keinen Kalender und kann keine Termine buchen." : "1 person has no calendar yet, so they cannot book meetings."
            : locale === "de" ? `${formatNumber(waiting.length, locale)} Personen haben noch keinen Kalender und können keine Termine buchen.` : `${waiting.length} people have no calendar yet, so they cannot book meetings.`}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {current.map((row) => (
          <li key={row.userId} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{row.name}</p>
              <p className="truncate text-sm text-muted-foreground">{row.email}</p>
            </div>
            {row.hasCalendar ? (
              <p className="text-sm font-semibold">{t.hasCalendar}</p>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="min-h-12"
                disabled={!connected || pendingId !== null}
                onClick={() => provision(row)}
              >
                {pendingId === row.userId ? t.creating : t.createCalendar}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {connected ? null : (
        <p className="text-sm text-muted-foreground">{t.connectFirst}</p>
      )}
    </div>
  );
}

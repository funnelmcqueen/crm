"use client";

import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { formatDate } from "@/lib/i18n/format";
import { CalendarCheck } from "lucide-react";
import { phraseSlot, zoneAbbreviation } from "@/lib/domain/slot-phrase";
import type { LeadMeeting } from "@/server/services/calendar-booking";
import { CancelAppointmentButton } from "./cancel-appointment-button";

export interface NextMeetingProps {
  meeting: LeadMeeting;
  /** The lead's time zone. */
  timeZone: string;
  now: Date;
  isAdmin: boolean;
}

/** The next scheduled meeting on a lead, as the viewer may see it (agents: only meetings they booked, via RLS). */
export function NextMeeting({ meeting, timeZone, now, isAdmin }: NextMeetingProps) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const start = new Date(meeting.start);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4 text-sm">
      <CalendarCheck aria-hidden className="size-5 shrink-0 text-primary" />
      <p className="min-w-0 flex-1">
        <span className="font-bold">{t.nextMeeting}</span> {locale === "de" ? formatDate(start, locale, { dateStyle: "medium", timeStyle: "short", timeZone }) : phraseSlot(start, timeZone, now)} {zoneAbbreviation(start, timeZone)}
        {isAdmin && meeting.bookedByName ? <span className="text-muted-foreground"> · {locale === "de" ? "Gebucht von" : "Booked by"} {meeting.bookedByName}</span> : null}
      </p>
      {isAdmin || meeting.bookedByMe ? <CancelAppointmentButton appointmentId={meeting.id} /> : null}
    </div>
  );
}

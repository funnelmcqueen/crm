"use client";
import { PhoneIncoming, PhoneOutgoing, Voicemail } from "lucide-react";
import Link from "next/link";
import { DateTime, formatDuration } from "@/components/common/datetime";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { CallButton } from "@/components/dialer/call-button";
import { ManualCallbackButton } from "@/components/calls/manual-callback-button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { CallHistoryRow } from "@/server/services/calls";

export interface CallHistoryListProps {
  rows: CallHistoryRow[];
  tz: string;
  now: number;
  isAdmin: boolean;
}

type Translations = ReturnType<typeof useTranslations>;

function localizedDuration(seconds: number | null, locale: Locale, t: Translations): string {
  if (locale === "en") return formatDuration(seconds);
  const whole = seconds === null || !Number.isFinite(seconds) || seconds < 0 ? 0 : Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return `${hours > 0 ? `${formatNumber(hours, locale)} ${t.callsList.hourShort} ` : ""}${formatNumber(minutes, locale)} ${t.min} ${formatNumber(secs, locale)} ${t.sec}`;
}

function titleFor(row: CallHistoryRow, t: Translations): string {
  return row.businessName ?? row.contactName ?? t.callsList.unknownCaller;
}

function resultFor(row: CallHistoryRow, locale: Locale, t: Translations): string {
  if (row.hasVoicemail) {
    const duration = row.voicemailDurationSeconds === null ? "" : ` · ${localizedDuration(row.voicemailDurationSeconds, locale, t)}`;
    return `${row.handledAt ? t.callsList.heardVoicemail : t.callsList.unheardVoicemail}${duration}`;
  }
  if (row.outcome) return t.outcomes[row.outcome] ?? t.leadHistory.notLogged;
  if (row.callStatus === "no-answer") return t.callsList.noAnswer;
  if (row.callStatus === "busy") return t.callsList.busy;
  if (row.callStatus === "failed") return t.callsList.failed;
  if (row.callStatus === "canceled") return t.callsList.canceled;
  if (row.callStatus === "completed") return t.callsList.completed;
  return t.callsList.inProgress;
}

function Direction({ row }: { row: CallHistoryRow }) {
  const t = useTranslations("workspace").callsList;
  return row.direction === "INBOUND" ? (
    <span className="inline-flex items-center gap-1 text-sm font-semibold"><PhoneIncoming aria-hidden className="size-4 text-sky-600" />{t.incoming}</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-sm font-semibold"><PhoneOutgoing aria-hidden className="size-4 text-emerald-600" />{t.outgoing}</span>
  );
}

function Caller({ row, mobile = false }: { row: CallHistoryRow; mobile?: boolean }) {
  const t = useTranslations("workspace");
  const phone = row.remoteE164 ? formatPhoneDisplay(row.remoteE164) : null;
  const name = titleFor(row, t);
  const linkClass = `${mobile ? "-my-3 py-3 text-base" : ""} block truncate font-bold outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50`;
  return (
    <div className="min-w-0">
      {row.leadId ? <Link href={`/leads/${row.leadId}`} className={linkClass}>{name}</Link> : <p className="truncate font-bold">{name}</p>}
      <p className="truncate text-xs text-muted-foreground tabular-nums">{[row.contactName && row.businessName ? row.contactName : null, phone].filter(Boolean).join(" · ") || t.callsList.noPhone}</p>
    </div>
  );
}

function Callback({ row }: { row: CallHistoryRow }) {
  const t = useTranslations("workspace");
  if (!row.remoteE164) return null;
  if (!row.leadId || !row.leadStatus) return <ManualCallbackButton phone={row.remoteE164} />;
  return (
    <CallButton
      lead={{ id: row.leadId, businessName: titleFor(row, t), contactName: row.contactName, phone: row.remoteE164, status: row.leadStatus }}
      label={t.callsList.callBack}
      className="w-full md:w-auto"
    />
  );
}

/** Desktop table from xl; compact cards below it preserve every call fact and the callback target. */
export function CallHistoryList({ rows, tz, now, isAdmin }: CallHistoryListProps) {
  const { locale } = useLocale();
  const t = useTranslations("workspace");
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border bg-card xl:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-11 pl-4">{t.callsList.direction}</TableHead>
              <TableHead>{t.callsList.callerLead}</TableHead>
              {isAdmin ? <TableHead>{t.callsList.agent}</TableHead> : null}
              <TableHead>{t.callsList.time}</TableHead>
              <TableHead>{t.callsList.result}</TableHead>
              <TableHead>{t.callsList.duration}</TableHead>
              <TableHead className="pr-4 text-right"><span className="sr-only">{t.callsList.callBack}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="py-3 pl-4"><Direction row={row} /></TableCell>
                <TableCell className="max-w-64 py-3"><Caller row={row} /></TableCell>
                {isAdmin ? <TableCell className="max-w-40 truncate">{row.agentName ?? t.callsList.unknown}</TableCell> : null}
                <TableCell><DateTime value={row.createdAt} tz={tz} now={now} locale={locale} className="text-sm whitespace-nowrap" /></TableCell>
                <TableCell><span className="inline-flex items-center gap-1 text-sm">{row.hasVoicemail ? <Voicemail aria-hidden className="size-4" /> : null}{resultFor(row, locale, t)}</span></TableCell>
                <TableCell className="tabular-nums">{localizedDuration(row.durationSeconds, locale, t)}</TableCell>
                <TableCell className="py-3 pr-4 text-right"><Callback row={row} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:hidden">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <Caller row={row} mobile />
              <span className="shrink-0 text-right text-xs text-muted-foreground"><DateTime value={row.createdAt} tz={tz} now={now} locale={locale} className="block text-sm text-foreground" /></span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
              <span><Direction row={row} /></span>
              <span className="truncate text-center">{resultFor(row, locale, t)}</span>
              <span className="text-right tabular-nums">{localizedDuration(row.durationSeconds, locale, t)}</span>
            </div>
            {isAdmin ? <p className="truncate text-xs text-muted-foreground">{t.callsList.agentPrefix} <span className="text-foreground">{row.agentName ?? t.callsList.unknown}</span></p> : null}
            <div className="mt-auto"><Callback row={row} /></div>
          </li>
        ))}
      </ul>
    </>
  );
}

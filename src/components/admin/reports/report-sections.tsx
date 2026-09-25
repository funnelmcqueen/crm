"use client";

import { useTranslations } from "@/components/i18n/locale-provider";
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import { cn } from "@/lib/utils";
import type { AgentReportRow, NumberReportRow, ReportTotals } from "@/server/services/reports";
import {
  SPAM_MAX_ANSWER_RATE,
  SPAM_MIN_DIALS,
  formatAvgCall,
  formatCount,
  formatPercent,
  isPossibleSpamFlag,
  talkMinutes,
} from "./format";

function SectionTitle({ id, children, aside }: { id: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h2 id={id} className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {children}
      </h2>
      {aside ? <span className="text-xs text-muted-foreground">{aside}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Team totals
// ---------------------------------------------------------------------------------------------

export function TeamTotals({ totals }: { totals: ReportTotals }) {
  const t = useTranslations("admin");
  const stats: Array<{ label: string; value: string }> = [
    { label: t["Dials"], value: formatCount(totals.dials) },
    { label: t["Connected"], value: formatCount(totals.connected) },
    { label: t["Connect rate"], value: formatPercent(totals.connectRate) },
    { label: t["Talk min"], value: formatCount(talkMinutes(totals.talkSeconds)) },
    { label: t["Avg call"], value: formatAvgCall(totals.avgCallSeconds) },
    { label: t["Interested"], value: formatCount(totals.interested) },
    { label: t["Appointments"], value: formatCount(totals.appointments) },
    { label: t["Clients"], value: formatCount(totals.clients) },
  ];
  return (
    <section aria-labelledby="report-totals" className="mb-8">
      <SectionTitle id="report-totals">{t["Team totals"]}</SectionTitle>
      {/* 1px gaps over the border color draw the dividers at every column count. */}
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-4 xl:grid-cols-8">
        {stats.map((stat) => (
          <div key={stat.label} className="flex flex-col gap-0.5 bg-card px-4 py-3">
            <dt className="text-xs text-muted-foreground">{stat.label}</dt>
            <dd className="text-2xl leading-tight font-extrabold tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Per agent
// ---------------------------------------------------------------------------------------------

function DisabledTag() {
  const t = useTranslations("admin");
  return <span className="ml-2 text-xs font-semibold text-muted-foreground">{t["Disabled"]}</span>;
}

export function AgentReport({ rows }: { rows: AgentReportRow[] }) {
  const t = useTranslations("admin");
  return (
    <section aria-labelledby="report-agents" className="mb-8">
      <SectionTitle id="report-agents" aside={t["Stats stay with whoever made the call"]}>
        {t["Per agent"]}
      </SectionTitle>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{t["No agents yet."]}</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border bg-card md:block">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-11 pl-4">{t["Agent"]}</TableHead>
                  <TableHead className="text-right">{t["Dials"]}</TableHead>
                  <TableHead className="text-right">{t["Connect rate"]}</TableHead>
                  <TableHead className="text-right">{t["Talk min"]}</TableHead>
                  <TableHead className="text-right">{t["Avg call"]}</TableHead>
                  <TableHead className="text-right">{t["Interested"]}</TableHead>
                  <TableHead className="text-right">{t["Appointments"]}</TableHead>
                  <TableHead className="pr-4 text-right">{t["Clients"]}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.userId} className="h-12">
                    <TableCell className={cn("max-w-64 truncate pl-4 font-bold", !row.active && "text-muted-foreground")}>
                      {row.name}
                      {row.active ? null : <DisabledTag />}
                    </TableCell>
                    <TableCell className="text-right font-extrabold tabular-nums">{formatCount(row.dials)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPercent(row.connectRate)}
                      <span className="ml-1 text-xs text-muted-foreground">({formatCount(row.connected)})</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(talkMinutes(row.talkSeconds))}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatAvgCall(row.avgCallSeconds)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(row.interested)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(row.appointments)}</TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">{formatCount(row.clients)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="flex flex-col gap-2 md:hidden">
            {rows.map((row) => (
              <li key={row.userId} className="rounded-xl border bg-card p-4">
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <p className={cn("min-w-0 truncate font-bold", !row.active && "text-muted-foreground")}>
                    {row.name}
                    {row.active ? null : <DisabledTag />}
                  </p>
                  <p className="shrink-0 text-sm text-muted-foreground">
                    <span className="text-lg font-extrabold text-foreground tabular-nums">{formatCount(row.dials)}</span> {t["Dials"].toLowerCase()}
                  </p>
                </div>
                <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
                  <MiniStat label={t["Connect"]} value={formatPercent(row.connectRate)} />
                  <MiniStat label={t["Talk min"]} value={formatCount(talkMinutes(row.talkSeconds))} />
                  <MiniStat label={t["Avg call"]} value={formatAvgCall(row.avgCallSeconds)} />
                  <MiniStat label={t["Interested"]} value={formatCount(row.interested)} />
                  <MiniStat label={t["Appts"]} value={formatCount(row.appointments)} />
                  <MiniStat label={t["Clients"]} value={formatCount(row.clients)} />
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-extrabold tabular-nums">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Per number
// ---------------------------------------------------------------------------------------------

function SpamHint({ id }: { id: string }) {
  const t = useTranslations("admin");
  return (
    <span id={id} className="inline-flex items-center gap-1 text-xs font-semibold text-destructive">
      <TriangleAlert aria-hidden className="size-3.5" />
      {t["Possible spam flag"]}
    </span>
  );
}

export function NumberReport({ rows }: { rows: NumberReportRow[] }) {
  const t = useTranslations("admin");
  return (
    <section aria-labelledby="report-numbers" className="mb-6">
      <SectionTitle id="report-numbers" aside={t["Answered = completed outbound calls with talk time"]}>
        {t["Per number"]}
      </SectionTitle>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          {t["No phone numbers yet."]}
        </p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border bg-card md:block">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-11 pl-4">{t["Number"]}</TableHead>
                  <TableHead>{t["Label"]}</TableHead>
                  <TableHead className="text-right">{t["Dials"]}</TableHead>
                  <TableHead className="text-right">{t["Answered"]}</TableHead>
                  <TableHead className="pr-4 text-right">{t["Answer rate"]}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const flagged = isPossibleSpamFlag(row.dials, row.answerRate);
                  const hintId = `spam-${row.phoneNumberId}`;
                  return (
                    <TableRow key={row.phoneNumberId} className={cn("h-12", flagged && "bg-destructive/5")}>
                      <TableCell className={cn("pl-4 font-bold whitespace-nowrap tabular-nums", !row.active && "text-muted-foreground")}>
                        {formatPhoneDisplay(row.e164)}
                        {row.active ? null : <DisabledTag />}
                      </TableCell>
                      <TableCell className="max-w-56 truncate text-muted-foreground">{row.label ?? "—"}</TableCell>
                      <TableCell className="text-right font-extrabold tabular-nums">{formatCount(row.dials)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCount(row.answered)}</TableCell>
                      <TableCell className="pr-4 text-right tabular-nums">
                        <span
                          aria-describedby={flagged ? hintId : undefined}
                          className={cn(flagged && "font-extrabold text-destructive")}
                        >
                          {formatPercent(row.answerRate)}
                        </span>
                        {flagged ? (
                          <span className="ml-2">
                            <SpamHint id={hintId} />
                          </span>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <ul className="flex flex-col gap-2 md:hidden">
            {rows.map((row) => {
              const flagged = isPossibleSpamFlag(row.dials, row.answerRate);
              return (
                <li key={row.phoneNumberId} className={cn("rounded-xl border bg-card p-4", flagged && "border-destructive/40")}>
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <p className={cn("truncate font-bold tabular-nums", !row.active && "text-muted-foreground")}>
                        {formatPhoneDisplay(row.e164)}
                        {row.active ? null : <DisabledTag />}
                      </p>
                      {row.label ? <p className="truncate text-sm text-muted-foreground">{row.label}</p> : null}
                    </div>
                    {flagged ? <SpamHint id={`spam-card-${row.phoneNumberId}`} /> : null}
                  </div>
                  <dl className="grid grid-cols-3 gap-x-3 text-sm">
                    <MiniStat label={t["Dials"]} value={formatCount(row.dials)} />
                    <MiniStat label={t["Answered"]} value={formatCount(row.answered)} />
                    <MiniStat label={t["Answer rate"]} value={formatPercent(row.answerRate)} />
                  </dl>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            {t["An answer rate under {rate} after {count}+ dials can mean carriers label the number as spam."].replace("{rate}", formatPercent(SPAM_MAX_ANSWER_RATE)).replace("{count}", String(SPAM_MIN_DIALS))}
          </p>
        </>
      )}
    </section>
  );
}

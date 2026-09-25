"use client";

import { useTranslations } from "@/components/i18n/locale-provider";
import { PhoneIncoming, PhoneOutgoing } from "lucide-react";
import Link from "next/link";
import { DateTime, formatDuration } from "@/components/common/datetime";
import { EmptyState } from "@/components/common/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CALL_OUTCOMES, isCallOutcome, type CallOutcome } from "@/lib/domain/outcomes";
import { cn } from "@/lib/utils";
import type { ActivityRange, AgentActivity, AgentActivityCall } from "@/server/services/agents";
import { formatCount, formatPercent, formatTalkTime } from "./format";

// Components may import only types from src/server; the Record type keeps this list in step with ActivityRange.
const ACTIVITY_RANGES: ActivityRange[] = ["today", "7d", "30d"];

export function ActivityRangeTabs({ userId, range }: { userId: string; range: ActivityRange }) {
  const t = useTranslations("admin");
  return (
    <nav aria-label={t["Date range"]} className="inline-flex rounded-lg border bg-card p-1">
      {ACTIVITY_RANGES.map((key) => {
        const current = key === range;
        return (
          <Link
            key={key}
            href={key === "today" ? `/admin/agents/${userId}` : `/admin/agents/${userId}?range=${key}`}
            aria-current={current ? "page" : undefined}
            scroll={false}
            className={cn(
              "flex min-h-12 min-w-20 items-center justify-center rounded-md px-3 text-sm font-semibold outline-none transition-colors duration-100 focus-visible:ring-3 focus-visible:ring-ring/50",
              current ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {key === "today" ? t["Today"] : key === "7d" ? t["Last 7 days"] : t["Last 30 days"]}
          </Link>
        );
      })}
    </nav>
  );
}

export function ActivityStats({ stats }: { stats: AgentActivity["stats"] }) {
  const t = useTranslations("admin");
  const items: Array<{ label: string; value: string; hint?: string }> = [
    { label: t["Dials"], value: formatCount(stats.dials) },
    { label: t["Connect rate"], value: formatPercent(stats.connectRate), hint: `${formatCount(stats.connected)} ${t["connected"]}` },
    { label: t["Talk"], value: formatTalkTime(stats.talkSeconds) },
    { label: t["Avg call"], value: formatDuration(stats.avgCallSeconds) },
    { label: t["Interested"], value: formatCount(stats.interested) },
    { label: t["Appointments"], value: formatCount(stats.appointments) },
    { label: t["Clients"], value: formatCount(stats.clients), hint: t["assigned now"] },
  ];
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-xl border bg-card sm:grid-cols-4 lg:grid-cols-7">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-0.5 border-b border-r p-3 lg:border-b-0">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="text-2xl leading-tight font-extrabold tabular-nums">{item.value}</dd>
          {item.hint ? <dd className="text-xs text-muted-foreground tabular-nums">{item.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

export function OutcomeBreakdown({ outcomes }: { outcomes: AgentActivity["outcomes"] }) {
  const t = useTranslations("admin");
  const w = useTranslations("workspace");
  const rows = CALL_OUTCOMES.map((outcome) => ({ outcome, count: outcomes[outcome] ?? 0 }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const max = Math.max(1, ...rows.map((row) => row.count));

  return (
    <section aria-labelledby="outcomes-title" className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <h2 id="outcomes-title" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t["Outcomes"]} <span className="normal-case tabular-nums">({formatCount(total)} {t["logged"]})</span>
      </h2>
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">{t["No outcomes logged in this range."]}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.outcome} className="grid grid-cols-[7.5rem_1fr_2.5rem] items-center gap-3 text-sm">
              <span className={cn("truncate", row.count === 0 && "text-muted-foreground")}>{w.outcomes[row.outcome]}</span>
              <span aria-hidden className="h-2 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-foreground/70"
                  style={{ width: `${(row.count / max) * 100}%` }}
                />
              </span>
              <span className="text-right font-extrabold tabular-nums">{formatCount(row.count)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function outcomeLabel(call: AgentActivityCall, messages: { outcomes: Readonly<Record<CallOutcome, string>> }, notLogged: string): string {
  if (call.outcome && isCallOutcome(call.outcome)) return messages.outcomes[call.outcome];
  return notLogged;
}

function LeadCell({ call }: { call: AgentActivityCall }) {
  const t = useTranslations("admin");
  if (!call.leadId) return <span className="text-muted-foreground">{t["Unknown caller"]}</span>;
  return (
    <Link
      href={`/leads/${call.leadId}`}
      className="block truncate font-semibold outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {call.businessName ?? t["Lead"]}
    </Link>
  );
}

function DirectionIcon({ call }: { call: AgentActivityCall }) {
  const t = useTranslations("admin");
  const inbound = call.direction === "INBOUND";
  const Icon = inbound ? PhoneIncoming : PhoneOutgoing;
  const label = `${inbound ? t["Inbound"] : t["Outbound"]} · ${call.mode === "IN_APP" ? t["In-app"] : t["Phone"]}`;
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground" title={label}>
      <Icon aria-hidden className="size-4" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export interface RecentCallsProps {
  calls: AgentActivityCall[];
  tz: string;
  now: number;
}

export function RecentCalls({ calls, tz, now }: RecentCallsProps) {
  const t = useTranslations("admin");
  const w = useTranslations("workspace");
  return (
    <section aria-labelledby="recent-calls-title" className="flex flex-col gap-3">
      <h2 id="recent-calls-title" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t["Recent calls"]} <span className="normal-case">({t["latest 50 in range"]})</span>
      </h2>
      {calls.length === 0 ? (
        <EmptyState title={t["No calls in this range"]} description={t["Calls this agent makes or answers show up here."]} />
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border bg-card md:block">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-11 pl-4">{t["When"]}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t["Direction"]}</span>
                  </TableHead>
                  <TableHead>{t["Lead"]}</TableHead>
                  <TableHead>{t["Outcome"]}</TableHead>
                  <TableHead className="pr-4 text-right">{t["Duration"]}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {calls.map((call) => (
                  <TableRow key={call.id} className="h-12">
                    <TableCell className="pl-4 whitespace-nowrap">
                      <DateTime value={call.createdAt} tz={tz} now={now} />
                    </TableCell>
                    <TableCell className="w-10">
                      <DirectionIcon call={call} />
                    </TableCell>
                    <TableCell className="max-w-72">
                      <LeadCell call={call} />
                    </TableCell>
                    <TableCell className={cn(!call.outcome && "text-muted-foreground")}>{outcomeLabel(call, w, t["Not logged"])}</TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">
                      {call.durationSeconds === null ? "—" : formatDuration(call.durationSeconds)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="flex flex-col divide-y rounded-xl border bg-card md:hidden">
            {calls.map((call) => (
              <li key={call.id} className="flex items-center gap-3 px-4 py-3">
                <DirectionIcon call={call} />
                <div className="min-w-0 flex-1">
                  <LeadCell call={call} />
                  <p className="truncate text-xs text-muted-foreground">
                    <DateTime value={call.createdAt} tz={tz} now={now} /> · {outcomeLabel(call, w, t["Not logged"])}
                  </p>
                </div>
                <span className="text-sm tabular-nums">
                  {call.durationSeconds === null ? "—" : formatDuration(call.durationSeconds)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

"use client";

import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { ChevronRight, Phone, SkipForward, TriangleAlert, UserPlus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { DialerDriverName } from "@/lib/dialer/types";
import { dailyGoal, goalFraction } from "@/lib/domain/daily-goal";
import { cn } from "@/lib/utils";
import type { AdminAttention, AgentStatsRow, TeamTotals } from "@/server/services/dashboard";
import { formatCount, formatTalkTime, teamTotalsItems } from "./format";
import { TargetBar } from "./target-bar";

export interface AdminDashboardViewProps {
  totals: TeamTotals;
  agents: AgentStatsRow[];
  attention: AdminAttention;
  driver: DialerDriverName;
}

/** Rows shown on the dashboard: every agent, plus admins who have leads or calls today. */
export function visibleAgentRows(rows: readonly AgentStatsRow[]): AgentStatsRow[] {
  return rows.filter(
    (r) => r.role === "AGENT" || r.leadsAssigned > 0 || r.dialsToday > 0 || r.talkSecondsToday > 0 || r.connectedToday > 0,
  );
}

function agentHref(row: AgentStatsRow): string {
  return `/admin/agents/${encodeURIComponent(row.userId)}`;
}

export function AdminDashboardView({ totals, agents, attention, driver }: AdminDashboardViewProps) {
  const t = useTranslations("operations");
  const rows = visibleAgentRows(agents);
  return (
    <div className="flex flex-col gap-4">
      <AttentionList totals={totals} attention={attention} driver={driver} />
      {totals.disabledAgentsWithLeads > 0 ? <DisabledAgentsBanner totals={totals} /> : null}
      <TeamTotalsRow totals={totals} />

      <section aria-labelledby="agents-heading" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="agents-heading" className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
            {t.agentsToday}
          </h2>
          <Link
            href="/admin/agents"
            // No md:min-h-8 here: 768px is a tablet, which is touch, so shrinking this to 32px there broke
            // the 48px rule on exactly the devices that need it.
            className="inline-flex min-h-12 items-center rounded-lg px-2 text-sm font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {t.manageAgents}
          </Link>
        </div>

        {rows.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            {t.noAgentsYet}
          </p>
        ) : (
          <>
            <AgentTable rows={rows} />
            <AgentCards rows={rows} />
          </>
        )}
      </section>
    </div>
  );
}

/**
 * Team operations that need an admin, most urgent first (DEVIATIONS D43): leads nobody will call, calling that
 * cannot connect, and skipped leads waiting on a decision. Renders nothing when there is nothing to do.
 */
function AttentionList({ totals, attention, driver }: { totals: TeamTotals; attention: AdminAttention; driver: DialerDriverName }) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const count = (value: number) => formatCount(value, locale);
  const items: Array<{ key: string; icon: ReactNode; text: ReactNode; href: string; cta: string; urgent: boolean }> = [];
  if (totals.leadsUnassigned > 0) {
    items.push({
      key: "unassigned",
      icon: <UserPlus />,
      text: (
        <>
          <span className="font-extrabold tabular-nums">{count(totals.leadsUnassigned)}</span> {locale === "de" ? totals.leadsUnassigned === 1 ? "nicht zugewiesener" : "nicht zugewiesene" : "unassigned"}{" "}
          {locale === "de" ? totals.leadsUnassigned === 1 ? "Lead ist" : "Leads sind" : totals.leadsUnassigned === 1 ? "lead is" : "leads are"} {locale === "de" ? "in keiner Anrufliste." : "not in anyone’s call queue."}
        </>
      ),
      href: "/leads?unassigned=1",
      cta: t.assignLeads,
      urgent: true,
    });
  }
  if (driver !== "tel" && attention.activePhoneNumbers === 0) {
    items.push({
      key: "numbers",
      icon: <Phone />,
      text: <>{locale === "de" ? "Keine aktiven Telefonnummern. Anrufe in der App haben keine Anruferkennung und können nicht verbunden werden." : "No active phone numbers, so in-app calls have no caller ID and cannot connect."}</>,
      href: "/admin/phone-numbers",
      cta: t.phoneNumbers,
      urgent: true,
    });
  }
  if (attention.skipped > 0) {
    items.push({
      key: "skipped",
      icon: <SkipForward />,
      text: (
        <>
          <span className="font-extrabold tabular-nums">{count(attention.skipped)}</span> {locale === "de" ? attention.skipped === 1 ? "übersprungener" : "übersprungene" : "skipped"}{" "}
          {locale === "de" ? attention.skipped === 1 ? "Lead wartet" : "Leads warten" : attention.skipped === 1 ? "lead is" : "leads are"} {locale === "de" ? "auf eine Entscheidung." : "waiting for a decision."}
        </>
      ),
      href: "/follow-ups?tab=skipped",
      cta: t.reviewSkipped,
      urgent: false,
    });
  }
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="attention-heading" className="flex flex-col gap-2">
      <h2 id="attention-heading" className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
        {t.needsAttention}
      </h2>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.key}
            className={cn(
              "flex flex-col gap-3 rounded-xl border p-3 text-sm sm:flex-row sm:items-center md:px-4",
              item.urgent ? "border-primary/40 bg-primary/5" : "bg-card",
            )}
          >
            <span aria-hidden className={cn("hidden shrink-0 sm:block [&_svg]:size-5", item.urgent ? "text-primary" : "text-muted-foreground")}>
              {item.icon}
            </span>
            <p className="min-w-0 flex-1">{item.text}</p>
            <Link
              href={item.href}
              className={cn(
                "inline-flex min-h-12 shrink-0 items-center justify-center rounded-xl px-4 font-bold outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50",
                item.urgent ? "bg-primary text-primary-foreground hover:bg-primary/85" : "border bg-card hover:bg-accent",
              )}
            >
              {item.cta}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DisabledAgentsBanner({ totals }: { totals: TeamTotals }) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const count = (value: number) => formatCount(value, locale);
  const leads = totals.leadsOnDisabledAgents;
  const agents = totals.disabledAgentsWithLeads;
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl border border-gold/50 bg-gold/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="flex items-start gap-3">
        <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-gold" />
        <span>
          {locale === "de" ? <><span className="font-extrabold tabular-nums">{count(leads)}</span> {leads === 1 ? "Lead ist" : "Leads sind"} noch <span className="font-extrabold tabular-nums">{count(agents)}</span> {agents === 1 ? "deaktiviertem Agenten" : "deaktivierten Agenten"} zugewiesen. Weise sie neu zu, damit sie angerufen werden.</> : <><span className="font-extrabold tabular-nums">{count(leads)}</span> {leads === 1 ? "lead is" : "leads are"} still assigned to <span className="font-extrabold tabular-nums">{count(agents)}</span> disabled {agents === 1 ? "agent" : "agents"}. Reassign them so they get called.</>}
        </span>
      </p>
      <Link
        href="/admin/agents"
        className="inline-flex min-h-12 shrink-0 items-center justify-center rounded-xl border bg-card px-4 font-bold outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {t.reviewAgents}
      </Link>
    </div>
  );
}

function TeamTotalsRow({ totals }: { totals: TeamTotals }) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const items = teamTotalsItems(totals, locale);
  return (
    <section aria-labelledby="team-heading">
      <h2 id="team-heading" className="sr-only">
        {t.teamTotals}
      </h2>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-4 lg:grid-cols-7">
        {items.map((item) => (
          <div key={item.label} className="flex flex-col gap-0.5 bg-card px-3 py-2.5">
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className="text-2xl font-extrabold tabular-nums">{item.value}</dd>
            {item.sub ? <dd className="text-xs text-muted-foreground tabular-nums">{item.sub}</dd> : null}
          </div>
        ))}
      </dl>
    </section>
  );
}

function ActiveBadge({ active }: { active: boolean }) {
  const { locale } = useLocale();
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-semibold",
        active ? "border-success/30 bg-success/10 text-foreground" : "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      {active ? (locale === "de" ? "Aktiv" : "Active") : (locale === "de" ? "Deaktiviert" : "Disabled")}
    </span>
  );
}

function CallsVsTarget({ row }: { row: AgentStatsRow }) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const count = (value: number) => formatCount(value, locale);
  const goal = dailyGoal(row.dialsToday, row.dailyCallTarget);
  return (
    <div className="flex min-w-32 flex-col gap-1">
      <span className="tabular-nums">
        {goal.hasTarget ? (
          <>
            <span className={cn("text-base font-extrabold", goal.reached && "text-gold")}>{count(goal.dials)}</span>
            <span className="text-muted-foreground"> / {count(goal.target)}</span>
          </>
        ) : (
          <span className="text-base font-extrabold">
            {locale === "de" ? `${count(goal.dials)} ${goal.dials === 1 ? t.call : t.calls}` : goalFraction(goal)} <span className="text-xs font-semibold text-muted-foreground">{t.noTarget}</span>
          </span>
        )}
      </span>
      <TargetBar goal={goal} size="thin" label={locale === "de" ? `Anrufe heute für ${row.name || row.email}` : `Calls today for ${row.name || row.email}`} />
    </div>
  );
}

/**
 * `relative` on the scroll container is load-bearing. This is the one table built from a raw <table>
 * rather than the Table primitive (whose container already carries it), and the header's `sr-only`
 * "Open" span is absolutely positioned. With no positioned ancestor that span resolved against the page
 * and laid the document out 907px wide inside a 768px viewport, so the whole page scrolled sideways
 * instead of the table scrolling inside its card. Same trap as follow-up-tabs.tsx and pipeline-board.tsx.
 */
function AgentTable({ rows }: { rows: AgentStatsRow[] }) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const count = (value: number) => formatCount(value, locale);
  return (
    <div className="relative hidden overflow-x-auto rounded-xl border bg-card md:block">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th scope="col" className="px-4 py-2.5 font-semibold">{t.agent}</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">{t.callsToday}</th>
            <th scope="col" className="px-4 py-2.5 text-right font-semibold">{t.connected}</th>
            <th scope="col" className="px-4 py-2.5 text-right font-semibold">{t.appointments}</th>
            <th scope="col" className="px-4 py-2.5 text-right font-semibold">{t.talkTime}</th>
            <th scope="col" className="w-10 px-2 py-2.5"><span className="sr-only">{t.open}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.userId}
              data-agent-row={row.userId}
              className={cn("relative border-b transition-colors duration-100 last:border-0 hover:bg-muted/50", !row.active && "text-muted-foreground")}
            >
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <Link
                    href={agentHref(row)}
                    className="truncate font-bold text-foreground outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
                  >
                    {row.name || row.email}
                  </Link>
                  <ActiveBadge active={row.active} />
                  {row.role === "ADMIN" ? <span className="text-[11px] font-semibold text-muted-foreground">{t.admin}</span> : null}
                </div>
                <p className="truncate text-xs text-muted-foreground">{row.email}</p>
              </td>
              <td className="px-4 py-3">
                <CallsVsTarget row={row} />
              </td>
              <td className="px-4 py-3 text-right text-base font-extrabold tabular-nums">{count(row.connectedToday)}</td>
              <td className="px-4 py-3 text-right text-base font-extrabold tabular-nums">{count(row.appointmentsToday)}</td>
              <td className="px-4 py-3 text-right text-base font-extrabold tabular-nums">{formatTalkTime(row.talkSecondsToday)}</td>
              <td className="px-2 py-3 text-muted-foreground">
                <ChevronRight aria-hidden className="size-4" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentCards({ rows }: { rows: AgentStatsRow[] }) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const count = (value: number) => formatCount(value, locale);
  return (
    <ul className="flex flex-col gap-2 md:hidden">
      {rows.map((row) => (
        <li key={row.userId}>
          <Link
            href={agentHref(row)}
            data-agent-card={row.userId}
            className="flex flex-col gap-3 rounded-xl border bg-card p-4 outline-none transition-colors duration-100 focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-muted"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-base font-bold">{row.name || row.email}</span>
                <ActiveBadge active={row.active} />
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </div>
            <CallsVsTarget row={row} />
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <dt className="text-muted-foreground">{t.connected}</dt>
                <dd className="text-base font-extrabold tabular-nums">{count(row.connectedToday)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t.appts}</dt>
                <dd className="text-base font-extrabold tabular-nums">{count(row.appointmentsToday)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t.talk}</dt>
                <dd className="text-base font-extrabold tabular-nums">{formatTalkTime(row.talkSecondsToday)}</dd>
              </div>
            </dl>
          </Link>
        </li>
      ))}
    </ul>
  );
}

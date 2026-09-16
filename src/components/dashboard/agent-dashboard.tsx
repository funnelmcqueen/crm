import { CalendarClock, CheckCheck, ChevronRight, Trophy, Voicemail } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { StatusBadge } from "@/components/common/status-badge";
import { CallButton } from "@/components/dialer/call-button";
import { NEXT_LEAD_REASON_LABELS, leadFlowHref, nextLeadHref } from "@/lib/dialer/skip-list";
import type { DialableLead } from "@/lib/dialer/types";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import { cn } from "@/lib/utils";
import type { MyDashboardStats } from "@/server/services/dashboard";
import type { NextLead } from "@/server/services/next-lead";
import { formatCount, formatTalkTime } from "./format";
import { TargetBar } from "./target-bar";

export interface AgentDashboardViewProps {
  stats: MyDashboardStats;
  nextLead: NextLead | null;
}

/** Agent dashboard: the agent's own day only. No team data is passed in or rendered. */
export function AgentDashboardView({ stats, nextLead }: AgentDashboardViewProps) {
  return (
    // min-w-0 on every grid item: grid items default to min-width:auto, so the next lead's nowrap business name
    // and status badge would size the column to their min-content and push the page wider than a phone screen.
    <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
      <TodayCard stats={stats} />
      <div className="min-w-0 lg:row-span-2">
        <NextLeadCard lead={nextLead} />
      </div>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <WorkLink
          href="/follow-ups"
          icon={<CalendarClock />}
          label="Follow-ups due"
          count={stats.followUpsDue}
          hint={stats.followUpsDue > 0 ? "Due today or overdue" : "Nothing due today"}
        />
        <WorkLink
          href="/follow-ups?tab=voicemails"
          icon={<Voicemail />}
          label="Unheard voicemails"
          count={stats.unheardVoicemails}
          hint={stats.unheardVoicemails > 0 ? "Listen and call back" : "All caught up"}
        />
      </div>
    </div>
  );
}

function TodayCard({ stats }: { stats: MyDashboardStats }) {
  const { dialsToday, dailyCallTarget, remaining, targetHit } = stats;
  return (
    <section aria-labelledby="today-heading" className="rounded-xl border bg-card p-4 md:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="today-heading" className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
          Today
        </h2>
        {targetHit ? (
          <span className="inline-flex h-6 items-center gap-1 rounded-full border border-gold px-2 text-xs font-bold text-gold">
            <Trophy aria-hidden className="size-3.5" />
            Target hit
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <p className="leading-none">
          <span
            data-testid="dials-today"
            className={cn("text-5xl font-extrabold tabular-nums md:text-6xl", targetHit && "text-gold")}
          >
            {formatCount(dialsToday)}
          </span>
          <span className="text-2xl font-extrabold text-muted-foreground tabular-nums md:text-3xl">
            {" "}
            / {formatCount(dailyCallTarget)}
          </span>
          <span className="ml-2 text-base font-semibold text-muted-foreground">calls</span>
        </p>
        <p className="text-base font-semibold text-muted-foreground" data-testid="remaining">
          {targetHit ? (
            <span className="text-gold">
              {dialsToday > dailyCallTarget ? `+${formatCount(dialsToday - dailyCallTarget)} over target` : "0 remaining"}
            </span>
          ) : (
            <>
              <span className="text-xl font-extrabold text-foreground tabular-nums">{formatCount(remaining)}</span> remaining
            </>
          )}
        </p>
      </div>

      <TargetBar
        dials={dialsToday}
        target={dailyCallTarget}
        hit={targetHit}
        label="Calls today against your daily target"
        className="mt-3"
      />

      <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
        <Stat label="Connected" value={formatCount(stats.connectedToday)} />
        <Stat label="Interested" value={formatCount(stats.interestedToday)} />
        <Stat label="Appointments" value={formatCount(stats.appointmentsToday)} />
        <Stat label="Talk time" value={formatTalkTime(stats.talkSecondsToday)} />
      </dl>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 bg-card px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-extrabold tabular-nums">{value}</dd>
    </div>
  );
}

function WorkLink({ href, icon, label, count, hint }: { href: string; icon: ReactNode; label: string; count: number; hint: string }) {
  return (
    <Link
      href={href}
      className="flex min-h-14 items-center gap-3 rounded-xl border bg-card px-4 py-3 outline-none transition-colors duration-100 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-muted"
    >
      <span
        aria-hidden
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted [&_svg]:size-5",
          count > 0 ? "text-primary" : "text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
      <span className="text-2xl font-extrabold tabular-nums">{formatCount(count)}</span>
      <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
    </Link>
  );
}

function NextLeadCard({ lead }: { lead: NextLead | null }) {
  if (!lead) {
    return (
      <section aria-labelledby="next-lead-heading" className="flex flex-col gap-3">
        <h2 id="next-lead-heading" className="sr-only">
          Next lead
        </h2>
        <EmptyState
          icon={<CheckCheck />}
          title="You're all caught up"
          description="No leads need a call right now. Check back later or browse your leads."
          className="bg-card"
          action={
            <Link
              href="/leads"
              className="inline-flex min-h-12 items-center rounded-xl border bg-card px-5 text-base font-bold outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Browse my leads
            </Link>
          }
        />
      </section>
    );
  }

  const dialable: DialableLead = {
    id: lead.leadId,
    businessName: lead.businessName,
    contactName: lead.contactName,
    phone: lead.phone,
    status: lead.status,
  };

  return (
    <section aria-labelledby="next-lead-heading" className="rounded-xl border bg-card p-4 md:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="next-lead-heading" className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
          Next lead
        </h2>
        <span className="text-xs font-semibold text-primary">{NEXT_LEAD_REASON_LABELS[lead.reason]}</span>
      </div>

      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-2xl font-extrabold tracking-tight">{lead.businessName}</p>
          {lead.contactName ? <p className="truncate text-base text-muted-foreground">{lead.contactName}</p> : null}
        </div>
        <StatusBadge status={lead.status} />
      </div>

      <p className="mt-2 text-lg font-bold tabular-nums">{formatPhoneDisplay(lead.phone)}</p>

      <div className="mt-4 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
        <CallButton lead={dialable} size="lg" />
        <div className="grid grid-cols-2 gap-2 md:flex">
          <Link
            href={leadFlowHref(lead.leadId, [], lead.reason)}
            className="inline-flex min-h-12 items-center justify-center rounded-xl border bg-card px-5 text-base font-bold outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Open lead
          </Link>
          <Link
            href={nextLeadHref([lead.leadId])}
            aria-label={`Skip ${lead.businessName}`}
            className="inline-flex min-h-12 items-center justify-center rounded-xl px-5 text-base font-bold text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Skip
          </Link>
        </div>
      </div>
    </section>
  );
}

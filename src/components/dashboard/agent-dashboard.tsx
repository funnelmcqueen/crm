import { CalendarClock, ChevronRight, PartyPopper, SkipForward, Voicemail } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { StatusBadge } from "@/components/common/status-badge";
import { CallButton } from "@/components/dialer/call-button";
import { SkipLeadMenu } from "@/components/dialer/skip-lead-menu";
import { NEXT_LEAD_REASON_LABELS, leadFlowHref, nextLeadHref } from "@/lib/dialer/skip-list";
import type { DialableLead, DialerDriverName } from "@/lib/dialer/types";
import {
  consistency,
  dailyGoal,
  goalCopy,
  goalFraction,
  nextBestAction,
  type CallDay,
  type DailyGoal,
  type GoalCopy,
} from "@/lib/domain/daily-goal";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import { cn } from "@/lib/utils";
import type { AgentToday, MyDashboardStats } from "@/server/services/dashboard";
import type { NextLead } from "@/server/services/next-lead";
import { CallingSetupNotice } from "./calling-setup-notice";
import { formatCount, formatTalkTime } from "./format";
import { TargetBar } from "./target-bar";

export interface AgentDashboardViewProps {
  stats: MyDashboardStats;
  nextLead: NextLead | null;
  today: AgentToday;
  /** Minutes since local midnight in the agent's timezone, at render time. */
  minuteOfDay: number;
  driver: DialerDriverName;
  inAppEnabled: boolean;
}

/**
 * The agent's Today workspace (docs/DEVIATIONS.md D43): what to do next, progress toward their own goal and their
 * own numbers. No team data is passed in or rendered, and nothing compares the agent with anyone else.
 */
export function AgentDashboardView({ stats, nextLead, today, minuteOfDay, driver, inAppEnabled }: AgentDashboardViewProps) {
  const goal = dailyGoal(stats.dialsToday, stats.dailyCallTarget);
  const copy = goalCopy(goal, minuteOfDay);
  return (
    <div className="flex flex-col gap-4">
      <CallingSetupNotice driver={driver} inAppEnabled={inAppEnabled} callerIdAvailable={today.callerIdAvailable} isAdmin={false} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start">
        <NextBestActionCard nextLead={nextLead} today={today} dialsToday={stats.dialsToday} goalReached={goal.reached} />
        <GoalCard goal={goal} copy={copy} callDays={today.callDays} />
      </div>

      <StatsGrid stats={stats} />

      <nav aria-label="Your work queues" className="grid gap-2 sm:grid-cols-3">
        <WorkLink
          href="/follow-ups"
          icon={<CalendarClock />}
          label="Follow-ups due"
          count={stats.followUpsDue}
          hint={today.overdueFollowUps > 0 ? `${formatCount(today.overdueFollowUps)} overdue` : stats.followUpsDue > 0 ? "Due today" : "Nothing due today"}
          attention={today.overdueFollowUps > 0}
        />
        <WorkLink
          href="/follow-ups?tab=voicemails"
          icon={<Voicemail />}
          label="Unheard voicemails"
          count={stats.unheardVoicemails}
          hint={stats.unheardVoicemails > 0 ? "Listen and call back" : "All caught up"}
          attention={stats.unheardVoicemails > 0}
        />
        <WorkLink
          href="/follow-ups?tab=skipped"
          icon={<SkipForward />}
          label="Skipped leads"
          count={today.skipped}
          hint={today.skipped > 0 ? "Waiting for a decision" : "None waiting"}
          attention={false}
        />
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Next best action
// ---------------------------------------------------------------------------------------------

function NextBestActionCard({
  nextLead,
  today,
  dialsToday,
  goalReached,
}: {
  nextLead: NextLead | null;
  today: AgentToday;
  dialsToday: number;
  goalReached: boolean;
}) {
  const action = nextBestAction({
    hasNextLead: nextLead !== null,
    dialsToday,
    overdueFollowUps: today.overdueFollowUps,
    skipped: today.skipped,
    leadsAssigned: today.leadsAssigned,
  });

  return (
    <section aria-labelledby="next-action-heading" className="flex min-w-0 flex-col gap-4 rounded-xl border border-primary/40 bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="next-action-heading" className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
          Next best action
        </h2>
        {nextLead ? <span className="text-xs font-semibold text-primary">{NEXT_LEAD_REASON_LABELS[nextLead.reason]}</span> : null}
      </div>

      <div>
        <p className="text-2xl font-extrabold tracking-tight md:text-3xl">{action.title}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {action.kind === "caught-up" && goalReached ? "Goal reached and nothing waiting. Nice work today." : action.description}
        </p>
      </div>

      {nextLead ? <NextLeadPreview lead={nextLead} /> : action.href && action.cta ? (
        <div>
          <Link
            href={action.href}
            className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-primary px-5 text-base font-bold text-primary-foreground outline-none transition-colors duration-150 hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {action.cta}
            <ChevronRight aria-hidden className="size-4" />
          </Link>
        </div>
      ) : null}
    </section>
  );
}

function NextLeadPreview({ lead }: { lead: NextLead }) {
  const dialable: DialableLead = {
    id: lead.leadId,
    businessName: lead.businessName,
    contactName: lead.contactName,
    phone: lead.phone,
    status: lead.status,
  };
  return (
    <div className="flex min-w-0 flex-col gap-4 rounded-lg border bg-background/40 p-3 md:p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xl font-extrabold">{lead.businessName}</p>
          {lead.contactName ? <p className="truncate text-base text-muted-foreground">{lead.contactName}</p> : null}
          <p className="mt-1 text-lg font-bold tabular-nums">{formatPhoneDisplay(lead.phone)}</p>
        </div>
        <StatusBadge status={lead.status} />
      </div>
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
        <CallButton lead={dialable} size="lg" className="h-14 text-lg font-extrabold md:min-w-44" />
        <div className="grid grid-cols-2 gap-2 md:flex">
          <Link
            href={leadFlowHref(lead.leadId, [], lead.reason)}
            className="inline-flex min-h-12 items-center justify-center rounded-xl border bg-card px-5 text-base font-bold outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Open lead
          </Link>
          <SkipLeadMenu
            leadId={lead.leadId}
            businessName={lead.businessName}
            nextHref={null}
            fallbackHref={nextLeadHref([lead.leadId])}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------------------------

function GoalCard({ goal, copy, callDays }: { goal: DailyGoal; copy: GoalCopy; callDays: CallDay[] }) {
  return (
    <section aria-labelledby="today-heading" className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 md:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="today-heading" className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
          Today&rsquo;s goal
        </h2>
        {goal.reached ? (
          <span className="inline-flex h-6 items-center gap-1 rounded-full border border-gold px-2 text-xs font-bold text-gold">
            <PartyPopper aria-hidden className="size-3.5" />
            Goal reached
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <p className="leading-none" data-testid="goal-fraction">
          {goal.hasTarget ? (
            <>
              <span data-testid="dials-today" className={cn("text-5xl font-extrabold tabular-nums", goal.reached && "text-gold")}>
                {formatCount(goal.dials)}
              </span>
              <span className="text-2xl font-extrabold text-muted-foreground tabular-nums"> / {formatCount(goal.target)}</span>
              <span className="ml-2 text-base font-semibold text-muted-foreground">calls</span>
            </>
          ) : (
            <span data-testid="dials-today" className="text-5xl font-extrabold tabular-nums">
              {goalFraction(goal)}
            </span>
          )}
        </p>
        {goal.hasTarget ? (
          <p className="text-sm font-semibold text-muted-foreground" data-testid="remaining">
            {goal.reached ? (
              <span className="text-gold">{goal.over > 0 ? `+${formatCount(goal.over)} past your goal` : "100%"}</span>
            ) : (
              <>
                <span className="text-lg font-extrabold text-foreground tabular-nums">{goal.percent}%</span> ·{" "}
                <span className="font-extrabold text-foreground tabular-nums">{formatCount(goal.remaining)}</span> to go
              </>
            )}
          </p>
        ) : null}
      </div>

      <TargetBar goal={goal} label="Calls today against your daily goal" />

      <div className="rounded-lg bg-muted/50 px-3 py-2">
        <p className="text-sm font-bold">{copy.title}</p>
        <p className="text-sm text-muted-foreground">{copy.body}</p>
      </div>

      {callDays.length > 0 ? <ConsistencyStrip days={callDays} /> : null}
    </section>
  );
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const WEEKDAY_LONG = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });

function ConsistencyStrip({ days }: { days: CallDay[] }) {
  const { activeDays, totalDays } = consistency(days);
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <p className="text-sm">
        Called on <span className="font-extrabold tabular-nums">{activeDays}</span> of the last {totalDays} days
      </p>
      <ol className="grid grid-cols-7 gap-1" aria-label="Calls on each of the last 7 days">
        {days.map((day, index) => {
          const date = new Date(`${day.day}T12:00:00Z`);
          const active = day.dials > 0;
          const isToday = index === days.length - 1;
          return (
            <li key={day.day} className="flex flex-col items-center gap-1">
              <span
                aria-hidden
                className={cn(
                  "flex size-8 items-center justify-center rounded-md border text-xs font-bold tabular-nums",
                  active ? "border-primary/50 bg-primary/15 text-foreground" : "border-dashed text-muted-foreground",
                  isToday && "ring-2 ring-ring/40",
                )}
              >
                {active ? (day.dials > 99 ? "99+" : day.dials) : "–"}
              </span>
              <span aria-hidden className={cn("text-[11px] text-muted-foreground", isToday && "font-bold text-foreground")}>
                {isToday ? "Today" : WEEKDAY.format(date)}
              </span>
              <span className="sr-only">
                {isToday ? "Today" : WEEKDAY_LONG.format(date)}: {day.dials === 1 ? "1 call" : `${day.dials} calls`}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Stats and queues
// ---------------------------------------------------------------------------------------------

function StatsGrid({ stats }: { stats: MyDashboardStats }) {
  // Same connect rate as Reports: connected calls over dials. No dials yet reads as "—", not 0%.
  const connectRate = stats.dialsToday > 0 ? `${Math.round((stats.connectedToday / stats.dialsToday) * 100)}%` : "—";
  return (
    <section aria-labelledby="my-stats-heading">
      <h2 id="my-stats-heading" className="mb-2 text-xs font-bold tracking-widest text-muted-foreground uppercase">
        Your numbers today
      </h2>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Calls" value={formatCount(stats.dialsToday)} />
        <Stat label="Connected" value={formatCount(stats.connectedToday)} />
        <Stat label="Connect rate" value={connectRate} />
        <Stat label="Interested" value={formatCount(stats.interestedToday)} />
        <Stat label="Appointments" value={formatCount(stats.appointmentsToday)} />
        <Stat label="Talk time" value={formatTalkTime(stats.talkSecondsToday)} />
      </dl>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 bg-card px-3 py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-extrabold tabular-nums">{value}</dd>
    </div>
  );
}

function WorkLink({
  href,
  icon,
  label,
  count,
  hint,
  attention,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  count: number;
  hint: string;
  attention: boolean;
}) {
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
        <span className={cn("block truncate text-xs", attention ? "font-semibold text-destructive" : "text-muted-foreground")}>{hint}</span>
      </span>
      <span className="text-2xl font-extrabold tabular-nums">{formatCount(count)}</span>
      <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
    </Link>
  );
}

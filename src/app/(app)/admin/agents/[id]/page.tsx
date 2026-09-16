import { ArrowLeft, Contact, PhoneOff } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ActivityRangeTabs,
  ActivityStats,
  OutcomeBreakdown,
  RecentCalls,
} from "@/components/admin/agents/agent-activity";
import { AgentStatusBadge } from "@/components/admin/agents/agents-list";
import { formatCount } from "@/components/admin/agents/format";
import { currentTime, formatDateTime } from "@/components/common/datetime";
import { PageHeader } from "@/components/common/page-header";
import { Button } from "@/components/ui/button";
import { timeZoneLabel } from "@/components/settings/timezones";
import { requireAdminPage } from "@/server/context";
import { getAgentActivity, parseActivityRange } from "@/server/services/agents";

export const metadata: Metadata = {
  title: "Agent activity",
};

export default async function AgentActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminPage();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const range = parseActivityRange(query.range);
  const activity = await getAgentActivity(ctx, id, range);
  // Only agents have a drill-down; admins, unknown and malformed ids get the regular 404.
  if (!activity || activity.profile.role !== "AGENT") notFound();

  const { profile, stats } = activity;
  const tz = activity.range.timezone;
  const now = currentTime();
  const lastInstant = new Date(Date.parse(activity.range.to) - 1).toISOString();
  const rangeText =
    range === "today"
      ? formatDateTime(activity.range.from, tz, "date", now)
      : `${formatDateTime(activity.range.from, tz, "date", now)} – ${formatDateTime(lastInstant, tz, "date", now)}`;

  return (
    <>
      <Link
        href="/admin/agents"
        className="mb-3 inline-flex min-h-12 items-center gap-2 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Agents
      </Link>

      <PageHeader
        title={profile.name}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <AgentStatusBadge active={profile.active} deleted={profile.deleted} />
            {profile.inAppCallingEnabled ? null : (
              <span className="inline-flex items-center gap-1 text-xs">
                <PhoneOff aria-hidden className="size-3" />
                Phone only
              </span>
            )}
            <span className="truncate">{profile.email}</span>
            <span aria-hidden>·</span>
            <span>
              <span className="font-extrabold text-foreground tabular-nums">{formatCount(profile.leadsAssigned)}</span>{" "}
              {profile.leadsAssigned === 1 ? "lead" : "leads"}
            </span>
            <span aria-hidden>·</span>
            <span>
              Target <span className="font-extrabold text-foreground tabular-nums">{formatCount(profile.dailyCallTarget)}</span>
              /day
            </span>
          </span>
        }
        actions={
          <Button asChild variant="outline" className="h-12 gap-2 px-4">
            <Link href={`/leads?agent=${profile.userId}`}>
              <Contact aria-hidden />
              View leads
            </Link>
          </Button>
        }
      />

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <ActivityRangeTabs userId={profile.userId} range={range} />
        <p className="text-xs text-muted-foreground">
          {rangeText} · {timeZoneLabel(tz)} time
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <ActivityStats stats={stats} />
        {stats.inboundCalls > 0 ? (
          <p className="-mt-2 text-xs text-muted-foreground">
            Includes <span className="tabular-nums">{formatCount(stats.inboundCalls)}</span> inbound{" "}
            {stats.inboundCalls === 1 ? "call" : "calls"} in talk time and outcomes.
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_1fr]">
          <OutcomeBreakdown outcomes={activity.outcomes} />
          <RecentCalls calls={activity.recentCalls} tz={tz} now={now} />
        </div>
      </div>
    </>
  );
}

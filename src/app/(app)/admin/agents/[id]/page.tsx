import { ArrowLeft, Contact, PhoneOff } from "lucide-react";
import type { Metadata } from "next";
import { appPageMetadata } from "@/lib/i18n/metadata";
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
import { currentTime } from "@/components/common/datetime";
import { PageHeader } from "@/components/common/page-header";
import { Button } from "@/components/ui/button";
import { getServerWorkspace } from "@/lib/i18n/server-workspace";
import adminEn from "@/lib/i18n/messages/en/admin";
import adminDe from "@/lib/i18n/messages/de/admin";
import { formatDate } from "@/lib/i18n/format";
import { timeZoneLabel } from "@/components/settings/timezones";
import { requireAdminPage } from "@/server/context";
import { getAgentActivity, parseActivityRange } from "@/server/services/agents";

export async function generateMetadata(): Promise<Metadata> {
  return appPageMetadata("Agent activity", "Agentenaktivität");
}

export default async function AgentActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminPage();
  const { locale } = await getServerWorkspace(ctx.profile.primary_locale);
  const t = locale === "de" ? adminDe : adminEn;
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
      ? formatDate(new Date(activity.range.from), locale, { dateStyle: "medium", timeZone: tz })
      : `${formatDate(new Date(activity.range.from), locale, { dateStyle: "medium", timeZone: tz })} – ${formatDate(new Date(lastInstant), locale, { dateStyle: "medium", timeZone: tz })}`;

  return (
    <>
      <Link
        href="/admin/agents"
        className="mb-3 inline-flex min-h-12 items-center gap-2 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t["Agents"]}
      </Link>

      <PageHeader
        title={profile.name}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <AgentStatusBadge active={profile.active} deleted={profile.deleted} />
            {profile.inAppCallingEnabled ? null : (
              <span className="inline-flex items-center gap-1 text-xs">
                <PhoneOff aria-hidden className="size-3" />
                {t["Phone only"]}
              </span>
            )}
            <span className="truncate">{profile.email}</span>
            <span aria-hidden>·</span>
            <span>
              <span className="font-extrabold text-foreground tabular-nums">{formatCount(profile.leadsAssigned)}</span>{" "}
              {profile.leadsAssigned === 1 ? t["lead"] : t["leads"]}
            </span>
            <span aria-hidden>·</span>
            <span>
              {t["Target"]} <span className="font-extrabold text-foreground tabular-nums">{formatCount(profile.dailyCallTarget)}</span>
              /{t["day"]}
            </span>
          </span>
        }
        actions={
          <Button asChild variant="outline" className="h-12 gap-2 px-4">
            <Link href={`/leads?agent=${profile.userId}`}>
              <Contact aria-hidden />
              {t["View leads"]}
            </Link>
          </Button>
        }
      />

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <ActivityRangeTabs userId={profile.userId} range={range} />
        <p className="text-xs text-muted-foreground">
          {rangeText} · {timeZoneLabel(tz)}
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <ActivityStats stats={stats} />
        {stats.inboundCalls > 0 ? (
          <p className="-mt-2 text-xs text-muted-foreground">
            {t["Includes {count} inbound calls in talk time and outcomes."].replace("{count}", formatCount(stats.inboundCalls))}
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

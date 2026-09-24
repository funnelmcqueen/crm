import { CalendarCheck, CalendarClock, CircleCheck, History, SearchX, SkipForward, Voicemail } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { currentTime } from "@/components/common/datetime";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { FollowUpList } from "@/components/follow-ups/follow-up-list";
import { FollowUpTabs } from "@/components/follow-ups/follow-up-tabs";
import { FollowUpsPagination } from "@/components/follow-ups/follow-ups-pagination";
import { defaultFollowUpTab, followUpsHref, parseFollowUpParams, type FollowUpTab } from "@/components/follow-ups/params";
import { SkippedLeadList } from "@/components/follow-ups/skipped-list";
import { VoicemailList } from "@/components/follow-ups/voicemail-list";
import { Button } from "@/components/ui/button";
import { getServerWorkspace } from "@/lib/i18n/server-workspace";
import { requireUserPage } from "@/server/context";
import { followUpCounts, listFollowUps, listVoicemails } from "@/server/services/follow-ups";
import { listAgentsForFilter } from "@/server/services/leads";
import { listSkippedLeads } from "@/server/services/skipped-leads";

export const metadata: Metadata = {
  title: "Follow-ups",
};

interface EmptyCopy {
  icon: ReactNode;
  title: string;
  agent: string;
  admin: string;
}

function emptyCopy(t: Awaited<ReturnType<typeof getServerWorkspace>>["t"]["queuePage"]): Record<FollowUpTab, EmptyCopy> { return {
  overdue: {
    icon: <CircleCheck />,
    title: t.nothingOverdue,
    agent: t.caughtUp,
    admin: t.teamNothingOverdue,
  },
  today: {
    icon: <CalendarCheck />,
    title: t.nothingToday,
    agent: t.todayAgent,
    admin: t.todayTeam,
  },
  upcoming: {
    icon: <CalendarClock />,
    title: t.noUpcoming,
    agent: t.upcomingAgent,
    admin: t.upcomingTeam,
  },
  completed: {
    icon: <History />,
    title: t.noCompleted,
    agent: t.completedDescription,
    admin: t.completedDescription,
  },
  voicemails: {
    icon: <Voicemail />,
    title: t.noVoicemails,
    agent: t.voicemailAgent,
    admin: t.voicemailTeam,
  },
  skipped: {
    icon: <SkipForward />,
    title: t.noSkipped,
    agent: t.skippedAgent,
    admin: t.skippedTeam,
  },
}; }

export default async function FollowUpsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireUserPage();
  const { t } = await getServerWorkspace(ctx.profile.primary_locale);
  const isAdmin = ctx.profile.role === "ADMIN";
  const params = parseFollowUpParams(await searchParams);
  const counts = await followUpCounts(ctx);
  const tab = params.tab ?? defaultFollowUpTab(counts.overdue);
  const tz = ctx.profile.timezone;
  const now = currentTime();

  const copy = emptyCopy(t.queuePage)[tab];
  const emptyState = (
    <EmptyState
      icon={copy.icon}
      title={copy.title}
      description={isAdmin ? copy.admin : copy.agent}
      action={
        !isAdmin && (tab === "overdue" || tab === "today") ? (
          <Button asChild className="h-12 px-5 font-bold">
            <Link href="/next">{t.nextLeadUi.nextLead}</Link>
          </Button>
        ) : null
      }
    />
  );
  const pastLastPage = (
    <EmptyState
      icon={<SearchX />}
      title={t.queuePage.shortPage}
      description={t.queuePage.shortDescription}
      action={
        <Button asChild className="h-12 px-5 font-bold">
          <Link href={followUpsHref(tab)}>{t.queuePage.pageOne}</Link>
        </Button>
      }
    />
  );

  let body: ReactNode;
  if (tab === "skipped") {
    const [result, agents] = await Promise.all([
      listSkippedLeads(ctx, params.page),
      isAdmin ? listAgentsForFilter(ctx) : Promise.resolve([]),
    ]);
    body =
      result.rows.length > 0 ? (
        <>
          <SkippedLeadList
            key={`skipped:${result.page}`}
            rows={result.rows}
            tz={tz}
            now={now}
            isAdmin={isAdmin}
            agents={agents.filter((agent) => agent.active).map((agent) => ({ id: agent.id, name: agent.name }))}
            empty={emptyState}
          />
          <FollowUpsPagination tab={tab} window={result} />
        </>
      ) : result.total > 0 ? (
        pastLastPage
      ) : (
        emptyState
      );
  } else if (tab === "voicemails") {
    const result = await listVoicemails(ctx, { page: params.page });
    body =
      result.rows.length > 0 ? (
        <>
          <VoicemailList rows={result.rows} tz={tz} now={now} />
          <FollowUpsPagination tab={tab} window={result} />
        </>
      ) : result.total > 0 ? (
        pastLastPage
      ) : (
        emptyState
      );
  } else {
    const result = await listFollowUps(ctx, tab, params.page);
    body =
      result.rows.length > 0 ? (
        <>
          <FollowUpList
            key={`${tab}:${result.page}`}
            rows={result.rows}
            tab={tab}
            tz={tz}
            now={now}
            isAdmin={isAdmin}
            empty={emptyState}
          />
          <FollowUpsPagination tab={tab} window={result} />
        </>
      ) : result.total > 0 ? (
        pastLastPage
      ) : (
        emptyState
      );
  }

  return (
    <>
      <PageHeader
        title={t.queues.title}
        description={
          <>
            {isAdmin ? t.queuePage.teamDescription : t.queuePage.agentDescription} {t.queuePage.timesIn}{" "}
            <span className="font-semibold text-foreground">{tz.replace(/_/g, " ")}</span>.
          </>
        }
      />
      <FollowUpTabs active={tab} counts={counts} />
      {body}
    </>
  );
}

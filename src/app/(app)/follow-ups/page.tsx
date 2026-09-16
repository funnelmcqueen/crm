import { CalendarCheck, CalendarClock, CircleCheck, History, SearchX, Voicemail } from "lucide-react";
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
import { VoicemailList } from "@/components/follow-ups/voicemail-list";
import { Button } from "@/components/ui/button";
import { requireUserPage } from "@/server/context";
import { followUpCounts, listFollowUps, listVoicemails } from "@/server/services/follow-ups";

export const metadata: Metadata = {
  title: "Follow-ups",
};

interface EmptyCopy {
  icon: ReactNode;
  title: string;
  agent: string;
  admin: string;
}

const EMPTY: Record<FollowUpTab, EmptyCopy> = {
  overdue: {
    icon: <CircleCheck />,
    title: "Nothing overdue",
    agent: "You're caught up.",
    admin: "No overdue follow-ups across the team.",
  },
  today: {
    icon: <CalendarCheck />,
    title: "Nothing else due today",
    agent: "Follow-ups due before midnight show up here.",
    admin: "No team follow-ups are due before midnight.",
  },
  upcoming: {
    icon: <CalendarClock />,
    title: "No upcoming follow-ups",
    agent: "Schedule one from a lead, or log a call as Follow Up.",
    admin: "No follow-ups are scheduled after today.",
  },
  completed: {
    icon: <History />,
    title: "No completed follow-ups yet",
    agent: "Completed follow-ups show up here, newest first.",
    admin: "Completed follow-ups show up here, newest first.",
  },
  voicemails: {
    icon: <Voicemail />,
    title: "No voicemails",
    agent: "Voicemails from your leads and your number show up here.",
    admin: "Voicemails from every lead and number show up here.",
  },
};

export default async function FollowUpsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireUserPage();
  const isAdmin = ctx.profile.role === "ADMIN";
  const params = parseFollowUpParams(await searchParams);
  const counts = await followUpCounts(ctx);
  const tab = params.tab ?? defaultFollowUpTab(counts.overdue);
  const tz = ctx.profile.timezone;
  const now = currentTime();

  const copy = EMPTY[tab];
  const emptyState = (
    <EmptyState
      icon={copy.icon}
      title={copy.title}
      description={isAdmin ? copy.admin : copy.agent}
      action={
        !isAdmin && (tab === "overdue" || tab === "today") ? (
          <Button asChild className="h-12 px-5 font-bold">
            <Link href="/next">Next lead</Link>
          </Button>
        ) : null
      }
    />
  );
  const pastLastPage = (
    <EmptyState
      icon={<SearchX />}
      title="Nothing on this page"
      description="The list is shorter than this page number."
      action={
        <Button asChild className="h-12 px-5 font-bold">
          <Link href={followUpsHref(tab)}>Go to page 1</Link>
        </Button>
      }
    />
  );

  let body: ReactNode;
  if (tab === "voicemails") {
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
        title="Follow-ups"
        description={
          <>
            {isAdmin ? "Every agent's follow-ups and voicemails." : "Your callbacks and voicemails."} Times in{" "}
            <span className="font-semibold text-foreground">{tz.replace(/_/g, " ")}</span>.
          </>
        }
      />
      <FollowUpTabs active={tab} counts={counts} />
      {body}
    </>
  );
}

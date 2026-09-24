import { ChevronLeft, ChevronRight, PhoneCall, SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { currentTime } from "@/components/common/datetime";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { CallHistoryFilters, callHistoryHref } from "@/components/calls/call-history-filters";
import { CallHistoryList } from "@/components/calls/call-history-list";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/i18n/format";
import { getServerWorkspace } from "@/lib/i18n/server-workspace";
import type { Locale } from "@/lib/i18n/locales";
import { requireUserPage } from "@/server/context";
import { CALL_HISTORY_TABS, listCallHistory, type CallHistoryTab } from "@/server/services/calls";
import { listAgentsForFilter } from "@/server/services/leads";

export const metadata: Metadata = { title: "Calls" };

const tabs = new Set<string>(CALL_HISTORY_TABS);
const pageSchema = z.coerce.number().int().min(1).max(100_000);
const agentIdSchema = z.uuid();

type SearchParams = Record<string, string | string[] | undefined>;

function first(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

function parseParams(params: SearchParams): { tab: CallHistoryTab; page: number; agentId?: string } {
  const tabValue = first(params, "tab")?.trim().toLowerCase();
  const pageValue = first(params, "page")?.trim();
  const agentValue = first(params, "agent")?.trim();
  const page = pageValue && /^\d+$/.test(pageValue) ? pageSchema.safeParse(pageValue) : null;
  const agent = agentIdSchema.safeParse(agentValue);
  return {
    tab: tabValue && tabs.has(tabValue) ? (tabValue as CallHistoryTab) : "all",
    page: page?.success ? page.data : 1,
    agentId: agent.success ? agent.data : undefined,
  };
}

function Pagination({ tab, agentId, page, pageCount, total, from, to, locale, t }: { tab: CallHistoryTab; agentId?: string; page: number; pageCount: number; total: number; from: number; to: number; locale: Locale; t: Awaited<ReturnType<typeof getServerWorkspace>>["t"] }) {
  if (total === 0 || pageCount <= 1) return null;
  const href = (nextPage: number) => callHistoryHref({ tab, agentId, page: nextPage });
  return (
    <nav aria-label={t.pagination.navigation} className="mt-4 flex items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {t.pagination.showing} <span className="font-extrabold text-foreground tabular-nums">{formatNumber(from, locale)}–{formatNumber(to, locale)}</span> {t.pagination.of}{" "}
        <span className="font-extrabold text-foreground tabular-nums">{formatNumber(total, locale)}</span>
      </p>
      <div className="flex items-center gap-2">
        {page > 1 ? <Button asChild variant="outline" className="h-12 px-3"><Link href={href(page - 1)} scroll={false} rel="prev"><ChevronLeft aria-hidden />{t.pagination.prev}</Link></Button> : <Button variant="outline" className="h-12 px-3" disabled><ChevronLeft aria-hidden />{t.pagination.prev}</Button>}
        {page < pageCount ? <Button asChild variant="outline" className="h-12 px-3"><Link href={href(page + 1)} scroll={false} rel="next">{t.pagination.next}<ChevronRight aria-hidden /></Link></Button> : <Button variant="outline" className="h-12 px-3" disabled>{t.pagination.next}<ChevronRight aria-hidden /></Button>}
      </div>
    </nav>
  );
}

export default async function CallsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireUserPage();
  const { locale, t } = await getServerWorkspace(ctx.profile.primary_locale);
  const isAdmin = ctx.profile.role === "ADMIN";
  const params = parseParams(await searchParams);
  const [history, agents] = await Promise.all([
    listCallHistory(ctx, { tab: params.tab, agentId: params.agentId, page: params.page }),
    isAdmin ? listAgentsForFilter(ctx) : Promise.resolve([]),
  ]);
  const tz = ctx.profile.timezone;
  const now = currentTime();

  return (
    <>
      <PageHeader
        title={t.callsPage.title}
        description={isAdmin ? t.callsPage.teamDescription : t.callsPage.myDescription}
      />
      <CallHistoryFilters
        tab={params.tab}
        isAdmin={isAdmin}
        agents={agents.filter((agent) => agent.active).map((agent) => ({ id: agent.id, name: agent.name }))}
        selectedAgentId={isAdmin ? params.agentId : undefined}
      />
      {history.rows.length > 0 ? (
        <>
          <CallHistoryList rows={history.rows} tz={tz} now={now} isAdmin={isAdmin} />
          <Pagination agentId={isAdmin ? params.agentId : undefined} {...history} locale={locale} t={t} />
        </>
      ) : history.total > 0 ? (
        <EmptyState icon={<SearchX />} title={t.leadsPage.nothingHere} description={t.callsPage.shortList} action={<Button asChild className="h-12 px-5 font-bold"><Link href={callHistoryHref({ tab: params.tab, agentId: params.agentId })}>{t.leadsPage.pageOne}</Link></Button>} />
      ) : (
        <EmptyState icon={<PhoneCall />} title={t.callsPage.noMatch} description={t.callsPage.empty} />
      )}
    </>
  );
}

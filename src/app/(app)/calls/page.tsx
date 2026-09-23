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

function Pagination({ tab, agentId, page, pageCount, total, from, to }: { tab: CallHistoryTab; agentId?: string; page: number; pageCount: number; total: number; from: number; to: number }) {
  if (total === 0 || pageCount <= 1) return null;
  const href = (nextPage: number) => callHistoryHref({ tab, agentId, page: nextPage });
  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Showing <span className="font-extrabold text-foreground tabular-nums">{from.toLocaleString("en-US")}–{to.toLocaleString("en-US")}</span> of{" "}
        <span className="font-extrabold text-foreground tabular-nums">{total.toLocaleString("en-US")}</span>
      </p>
      <div className="flex items-center gap-2">
        {page > 1 ? <Button asChild variant="outline" className="h-12 px-3"><Link href={href(page - 1)} scroll={false} rel="prev"><ChevronLeft aria-hidden />Prev</Link></Button> : <Button variant="outline" className="h-12 px-3" disabled><ChevronLeft aria-hidden />Prev</Button>}
        {page < pageCount ? <Button asChild variant="outline" className="h-12 px-3"><Link href={href(page + 1)} scroll={false} rel="next">Next<ChevronRight aria-hidden /></Link></Button> : <Button variant="outline" className="h-12 px-3" disabled>Next<ChevronRight aria-hidden /></Button>}
      </div>
    </nav>
  );
}

export default async function CallsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireUserPage();
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
        title="Calls"
        description={isAdmin ? "Inbound and outbound calls across the team." : "Your inbound and outbound call history."}
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
          <Pagination agentId={isAdmin ? params.agentId : undefined} {...history} />
        </>
      ) : history.total > 0 ? (
        <EmptyState icon={<SearchX />} title="Nothing on this page" description="The call list is shorter than this page number." action={<Button asChild className="h-12 px-5 font-bold"><Link href={callHistoryHref({ tab: params.tab, agentId: params.agentId })}>Go to page 1</Link></Button>} />
      ) : (
        <EmptyState icon={<PhoneCall />} title="No matching calls" description="Matching inbound and outbound calls will appear here." />
      )}
    </>
  );
}
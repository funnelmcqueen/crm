import { Contact, SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { currentTime } from "@/components/common/datetime";
import { LeadCards } from "@/components/leads/lead-cards";
import { LeadsPagination } from "@/components/leads/leads-pagination";
import { LeadsTable } from "@/components/leads/leads-table";
import { LeadsToolbar } from "@/components/leads/leads-toolbar";
import { BulkActionBar } from "@/components/leads/bulk/bulk-action-bar";
import { selectionScope } from "@/components/leads/bulk/selection";
import { LeadSelectionProvider } from "@/components/leads/bulk/selection-context";
import { UnassignedCallout } from "@/components/leads/bulk/unassigned-callout";
import { hasActiveFilters, leadListHref, parseLeadListParams } from "@/components/leads/list-params";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/i18n/format";
import { getServerWorkspace } from "@/lib/i18n/server-workspace";
import { requireUserPage } from "@/server/context";
import { countUnassignedLeads, listAgentsForFilter, listLeadSources, listLeads, type AgentOption } from "@/server/services/leads";

export const metadata: Metadata = {
  title: "Leads",
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireUserPage();
  const { locale, t } = await getServerWorkspace(ctx.profile.primary_locale);
  const isAdmin = ctx.profile.role === "ADMIN";
  const parsed = parseLeadListParams(await searchParams);
  const params = isAdmin ? parsed : { ...parsed, agent: null, unassigned: false };

  const [result, sources, agents, unassigned] = await Promise.all([
    listLeads(ctx, {
      query: params.q,
      statuses: params.statuses,
      source: params.source,
      agentId: params.agent,
      unassigned: params.unassigned,
      sort: params.sort,
      dir: params.dir,
      page: params.page,
    }),
    listLeadSources(ctx),
    isAdmin ? listAgentsForFilter(ctx) : Promise.resolve<AgentOption[]>([]),
    isAdmin ? countUnassignedLeads(ctx) : Promise.resolve(0),
  ]);

  const tz = ctx.profile.timezone;
  const now = currentTime();
  const agentNames = isAdmin ? Object.fromEntries(agents.map((a) => [a.id, a.name])) : null;
  const filtered = hasActiveFilters(params);
  const resetHref = leadListHref({ ...params, q: "", statuses: [], source: null, agent: null, unassigned: false, page: 1 });
  const unassignedHref = leadListHref({ ...params, q: "", statuses: [], source: null, agent: null, unassigned: true, page: 1 });
  const showingUnassigned = params.unassigned && params.q === "" && params.statuses.length === 0 && params.source === null;
  const assignTargets = agents
    .filter((agent) => agent.active)
    .map((agent) => ({ id: agent.id, name: agent.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader
        title={isAdmin ? t.leadsPage.allLeads : t.leadsPage.myLeads}
        description={
          <>
            <span className="font-extrabold text-foreground tabular-nums">{formatNumber(result.total, locale)}</span>{" "}
            {result.total === 1 ? t.leadsPage.lead : t.leadsPage.leads}
            {filtered ? t.leadsPage.match : isAdmin ? t.leadsPage.inTotal : t.leadsPage.assignedToYou}
          </>
        }
        actions={
          isAdmin ? (
            <Button asChild variant="outline" className="h-12 px-4">
              <Link href="/admin/import">{t.leadsPage.importCsv}</Link>
            </Button>
          ) : null
        }
      />

      <LeadsToolbar
        params={params}
        sources={sources}
        agents={agents.map((a) => ({ id: a.id, name: a.name, active: a.active }))}
        isAdmin={isAdmin}
      />

      <LeadSelectionProvider
        scope={selectionScope(ctx.profile.role, params)}
        pageIds={result.rows.map((row) => row.id)}
        total={result.total}
        filters={{
          query: params.q,
          statuses: params.statuses,
          source: params.source,
          agentId: params.agent,
          unassigned: params.unassigned,
        }}
        isAdmin={isAdmin}
      >
        {isAdmin ? (
          <UnassignedCallout unassigned={unassigned} showingUnassigned={showingUnassigned} unassignedHref={unassignedHref} />
        ) : null}
        <BulkActionBar agents={assignTargets} sources={sources} tz={tz} now={now} />
        {result.rows.length > 0 ? (
          <>
            <LeadsTable rows={result.rows} tz={tz} now={now} agentNames={agentNames} />
            <LeadCards rows={result.rows} tz={tz} now={now} agentNames={agentNames} />
            <LeadsPagination params={params} window={result} />
          </>
        ) : null}
      </LeadSelectionProvider>

      {result.rows.length > 0 ? null : result.total > 0 ? (
        <EmptyState
          icon={<SearchX />}
          title={t.leadsPage.nothingHere}
          description={t.leadsPage.shortList}
          action={
            <Button asChild className="h-12 px-5 font-bold">
              <Link href={leadListHref({ ...params, page: 1 })}>{t.leadsPage.pageOne}</Link>
            </Button>
          }
        />
      ) : filtered ? (
        <EmptyState
          icon={<SearchX />}
          title={t.leadsPage.noMatch}
          description={t.leadsPage.tryFilters}
          action={
            <Button asChild variant="outline" className="h-12 px-5">
              <Link href={resetHref}>{t.leadsPage.clearFilters}</Link>
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={<Contact />}
          title={t.leadsPage.noLeads}
          description={isAdmin ? t.leadsPage.importPrompt : t.leadsPage.assignedPrompt}
          action={
            isAdmin ? (
              <Button asChild className="h-12 px-5 font-bold">
                <Link href="/admin/import">{t.leadsPage.importLeads}</Link>
              </Button>
            ) : null
          }
        />
      )}
    </>
  );
}

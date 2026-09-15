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
import { hasActiveFilters, leadListHref, parseLeadListParams } from "@/components/leads/list-params";
import { Button } from "@/components/ui/button";
import { requireUserPage } from "@/server/context";
import { listAgentsForFilter, listLeadSources, listLeads, type AgentOption } from "@/server/services/leads";

export const metadata: Metadata = {
  title: "Leads",
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireUserPage();
  const isAdmin = ctx.profile.role === "ADMIN";
  const parsed = parseLeadListParams(await searchParams);
  const params = isAdmin ? parsed : { ...parsed, agent: null, unassigned: false };

  const [result, sources, agents] = await Promise.all([
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
  ]);

  const tz = ctx.profile.timezone;
  const now = currentTime();
  const agentNames = isAdmin ? Object.fromEntries(agents.map((a) => [a.id, a.name])) : null;
  const filtered = hasActiveFilters(params);
  const resetHref = leadListHref({ ...params, q: "", statuses: [], source: null, agent: null, unassigned: false, page: 1 });

  return (
    <>
      <PageHeader
        title={isAdmin ? "All Leads" : "My Leads"}
        description={
          <>
            <span className="font-extrabold text-foreground tabular-nums">{result.total.toLocaleString("en-US")}</span>{" "}
            {result.total === 1 ? "lead" : "leads"}
            {filtered ? " match" : isAdmin ? " in total" : " assigned to you"}
          </>
        }
        actions={
          isAdmin ? (
            <Button asChild variant="outline" className="h-12 px-4">
              <Link href="/admin/import">Import CSV</Link>
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

      {result.rows.length > 0 ? (
        <>
          <LeadsTable rows={result.rows} tz={tz} now={now} agentNames={agentNames} />
          <LeadCards rows={result.rows} tz={tz} now={now} agentNames={agentNames} />
          <LeadsPagination params={params} window={result} />
        </>
      ) : result.total > 0 ? (
        <EmptyState
          icon={<SearchX />}
          title="Nothing on this page"
          description="The list is shorter than this page number."
          action={
            <Button asChild className="h-12 px-5 font-bold">
              <Link href={leadListHref({ ...params, page: 1 })}>Go to page 1</Link>
            </Button>
          }
        />
      ) : filtered ? (
        <EmptyState
          icon={<SearchX />}
          title="No leads match"
          description="Try a different search, or clear the filters."
          action={
            <Button asChild variant="outline" className="h-12 px-5">
              <Link href={resetHref}>Clear filters</Link>
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={<Contact />}
          title="No leads yet"
          description={isAdmin ? "Import a CSV to add leads." : "Leads assigned to you will show up here."}
          action={
            isAdmin ? (
              <Button asChild className="h-12 px-5 font-bold">
                <Link href="/admin/import">Import leads</Link>
              </Button>
            ) : null
          }
        />
      )}
    </>
  );
}

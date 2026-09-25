import { Columns3 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { currentTime } from "@/components/common/datetime";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { parsePipelineParams, pipelineHref } from "@/components/pipeline/params";
import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { PipelineToolbar } from "@/components/pipeline/pipeline-toolbar";
import { getServerWorkspace } from "@/lib/i18n/server-workspace";
import { formatNumber } from "@/lib/i18n/format";
import operationsEn from "@/lib/i18n/messages/en/operations";
import operationsDe from "@/lib/i18n/messages/de/operations";
import { Button } from "@/components/ui/button";
import { requireUserPage } from "@/server/context";
import { listAgentsForFilter, type AgentOption } from "@/server/services/leads";
import { getPipelineBoard } from "@/server/services/pipeline";

export const metadata: Metadata = {
  title: "Pipeline",
};

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireUserPage();
  const { locale } = await getServerWorkspace(ctx.profile.primary_locale);
  const t = locale === "de" ? operationsDe : operationsEn;
  const isAdmin = ctx.profile.role === "ADMIN";
  const parsed = parsePipelineParams(await searchParams);
  // Agents always see only their own leads; the RPC ignores these filters for them as well.
  const params = isAdmin ? parsed : { ...parsed, agent: null, unassigned: false };

  const [board, agents] = await Promise.all([
    getPipelineBoard(ctx, { closed: params.closed, agentId: params.agent, unassigned: params.unassigned }),
    isAdmin ? listAgentsForFilter(ctx) : Promise.resolve<AgentOption[]>([]),
  ]);

  const total = board.columns.reduce((sum, column) => sum + column.total, 0);
  const filtered = params.agent !== null || params.unassigned;
  const agentNames = isAdmin && !filtered ? Object.fromEntries(agents.map((a) => [a.id, a.name])) : null;

  return (
    <>
      <PageHeader
        title={t.pipelineTitle}
        description={
          <>
            <span className="font-extrabold text-foreground tabular-nums">{formatNumber(total, locale)}</span>{" "}
            {total === 1 ? t.pipelineLead : t.pipelineLeads}
            {params.closed ? "" : t.pipelineOpen}
            {isAdmin ? (filtered ? t.pipelineForFilter : "") : t.pipelineAssignedYou}
          </>
        }
      />

      <PipelineToolbar
        params={params}
        isAdmin={isAdmin}
        agents={agents.map((a) => ({ id: a.id, name: a.name, active: a.active }))}
      />

      {total === 0 ? (
        <EmptyState
          icon={<Columns3 />}
          title={filtered ? t.pipelineEmptyFiltered : t.pipelineEmpty}
          description={
            params.closed
              ? isAdmin
                ? t.pipelineEmptyAdmin
                : t.pipelineEmptyAgent
              : t.pipelineClosedHidden
          }
          action={
            filtered ? (
              <Button asChild variant="outline" className="h-12 px-5">
                <Link href={pipelineHref({ ...params, agent: null, unassigned: false })}>{t.pipelineShowAll}</Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <PipelineBoard
          initialColumns={board.columns}
          isAdmin={isAdmin}
          agentId={params.agent}
          unassigned={params.unassigned}
          tz={ctx.profile.timezone}
          now={currentTime()}
          agentNames={agentNames}
        />
      )}
    </>
  );
}

import { Columns3 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { currentTime } from "@/components/common/datetime";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { parsePipelineParams, pipelineHref } from "@/components/pipeline/params";
import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { PipelineToolbar } from "@/components/pipeline/pipeline-toolbar";
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
        title="Pipeline"
        description={
          <>
            <span className="font-extrabold text-foreground tabular-nums">{total.toLocaleString("en-US")}</span>{" "}
            {total === 1 ? "lead" : "leads"}
            {params.closed ? "" : " open"}
            {isAdmin ? (filtered ? " for this filter" : "") : " assigned to you"}
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
          title={filtered ? "No leads for this filter" : "Your pipeline is empty"}
          description={
            params.closed
              ? isAdmin
                ? "Import a CSV or assign leads to see them here."
                : "Leads assigned to you will show up here."
              : "Closed leads are hidden. Turn on Show closed to see them."
          }
          action={
            filtered ? (
              <Button asChild variant="outline" className="h-12 px-5">
                <Link href={pipelineHref({ ...params, agent: null, unassigned: false })}>Show all agents</Link>
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

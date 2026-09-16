import { UsersRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CreateAgentDialog } from "@/components/admin/agents/agent-dialogs";
import { AgentCards, AgentsTable } from "@/components/admin/agents/agents-list";
import { DisabledAgentsBanner } from "@/components/admin/agents/disabled-agents-banner";
import { formatCount } from "@/components/admin/agents/format";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { Button } from "@/components/ui/button";
import { requireAdminPage } from "@/server/context";
import { listAgents } from "@/server/services/agents";
import { getCompanyDefaults } from "@/server/services/settings";

export const metadata: Metadata = {
  title: "Agents",
};

export default async function AgentsPage() {
  const ctx = await requireAdminPage();
  const [data, defaults] = await Promise.all([listAgents(ctx), getCompanyDefaults(ctx)]);
  const activeCount = data.agents.filter((agent) => agent.active).length;

  return (
    <>
      <PageHeader
        title="Agents"
        description={
          <>
            <span className="font-extrabold text-foreground tabular-nums">{formatCount(data.agents.length)}</span>{" "}
            {data.agents.length === 1 ? "agent" : "agents"} ·{" "}
            <span className="font-extrabold text-foreground tabular-nums">{formatCount(activeCount)}</span> active · today
            in each agent&rsquo;s time zone
          </>
        }
        actions={
          <>
            <Button asChild variant="outline" className="h-12 px-4">
              <Link href="/admin/import">Import CSV</Link>
            </Button>
            <CreateAgentDialog defaultTarget={defaults.defaultDailyTarget} defaultTimezone={defaults.defaultTimezone} />
          </>
        }
      />

      <DisabledAgentsBanner disabled={data.disabledWithLeads} reassignTargets={data.reassignTargets} />

      {data.agents.length > 0 ? (
        <>
          <AgentsTable agents={data.agents} reassignTargets={data.reassignTargets} />
          <AgentCards agents={data.agents} reassignTargets={data.reassignTargets} />
        </>
      ) : (
        <EmptyState
          icon={<UsersRound />}
          title="No agents yet"
          description="Create an agent to give them a login and start assigning leads."
        />
      )}
    </>
  );
}

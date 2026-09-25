import { UsersRound } from "lucide-react";
import type { Metadata } from "next";
import { appPageMetadata } from "@/lib/i18n/metadata";
import Link from "next/link";
import { CreateAgentDialog } from "@/components/admin/agents/agent-dialogs";
import { AgentCards, AgentsTable } from "@/components/admin/agents/agents-list";
import { DisabledAgentsBanner } from "@/components/admin/agents/disabled-agents-banner";
import { formatCount } from "@/components/admin/agents/format";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { Button } from "@/components/ui/button";
import { getServerWorkspace } from "@/lib/i18n/server-workspace";
import adminEn from "@/lib/i18n/messages/en/admin";
import adminDe from "@/lib/i18n/messages/de/admin";
import { requireAdminPage } from "@/server/context";
import { listAgents } from "@/server/services/agents";
import { getCompanyDefaults } from "@/server/services/settings";

export async function generateMetadata(): Promise<Metadata> {
  return appPageMetadata("Agents", "Agenten");
}

export default async function AgentsPage() {
  const ctx = await requireAdminPage();
  const { locale } = await getServerWorkspace(ctx.profile.primary_locale);
  const t = locale === "de" ? adminDe : adminEn;
  const [data, defaults] = await Promise.all([listAgents(ctx), getCompanyDefaults(ctx)]);
  const activeCount = data.agents.filter((agent) => agent.active).length;

  return (
    <>
      <PageHeader
        title={t["Agents"]}
        description={
          <>
            <span className="font-extrabold text-foreground tabular-nums">{formatCount(data.agents.length)}</span>{" "}
            {data.agents.length === 1 ? t["agent"] : t["agents"]} ·{" "}
            <span className="font-extrabold text-foreground tabular-nums">{formatCount(activeCount)}</span> {t["active in each agent’s time zone"]}
          </>
        }
        actions={
          <>
            <Button asChild variant="outline" className="h-12 px-4">
              <Link href="/admin/import">{t["Import CSV"]}</Link>
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
          title={t["No agents yet"]}
          description={t["Create an agent to give them a login and start assigning leads."]}
        />
      )}
    </>
  );
}

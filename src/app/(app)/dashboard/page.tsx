import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { AdminDashboardView } from "@/components/dashboard/admin-dashboard";
import { AgentDashboardView } from "@/components/dashboard/agent-dashboard";
import { currentTime } from "@/components/common/datetime";
import { formatInTz, isValidTimeZone } from "@/lib/domain/time";
import { requireUserPage } from "@/server/context";
import { getAdminDashboard, getAgentDashboard } from "@/server/services/dashboard";

export const metadata: Metadata = {
  title: "Dashboard",
};

function todayLabel(tz: string, now: number): string {
  return formatInTz(now, isValidTimeZone(tz) ? tz : "America/New_York", "EEEE, MMM d");
}

export default async function DashboardPage() {
  const ctx = await requireUserPage();
  const now = currentTime();

  if (ctx.profile.role === "ADMIN") {
    const { totals, agents } = await getAdminDashboard(ctx);
    return (
      <>
        <PageHeader
          title="Dashboard"
          description={<>Team today · each agent&apos;s day runs in their own timezone</>}
        />
        <AdminDashboardView totals={totals} agents={agents} />
      </>
    );
  }

  const { stats, nextLead } = await getAgentDashboard(ctx);
  return (
    <>
      <PageHeader title="Dashboard" description={todayLabel(stats.timezone, now)} />
      <AgentDashboardView stats={stats} nextLead={nextLead} />
    </>
  );
}

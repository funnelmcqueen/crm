import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { AdminDashboardView } from "@/components/dashboard/admin-dashboard";
import { AgentDashboardView } from "@/components/dashboard/agent-dashboard";
import { currentTime } from "@/components/common/datetime";
import { formatInTz, isValidTimeZone } from "@/lib/domain/time";
import { requireUserPage } from "@/server/context";
import { getDialerDriver, type DialerDriver } from "@/server/env";
import { getAdminDashboard, getAgentDashboard } from "@/server/services/dashboard";

export const metadata: Metadata = {
  title: "Dashboard",
};

function todayLabel(tz: string, now: number): string {
  return formatInTz(now, isValidTimeZone(tz) ? tz : "America/New_York", "EEEE, MMM d");
}

function minuteOfDay(tz: string, now: number): number {
  const [hours, minutes] = formatInTz(now, isValidTimeZone(tz) ? tz : "America/New_York", "H:m").split(":").map(Number);
  return hours * 60 + minutes;
}

/** Same fallback as the app layout: a broken Twilio config still leaves phone calls working. */
function dialerDriver(): DialerDriver {
  try {
    return getDialerDriver();
  } catch {
    return "tel";
  }
}

export default async function DashboardPage() {
  const ctx = await requireUserPage();
  const now = currentTime();

  if (ctx.profile.role === "ADMIN") {
    const { totals, agents, attention } = await getAdminDashboard(ctx);
    return (
      <>
        <PageHeader
          title="Dashboard"
          description={<>Team today · each agent&apos;s day runs in their own timezone</>}
        />
        <AdminDashboardView totals={totals} agents={agents} attention={attention} driver={dialerDriver()} />
      </>
    );
  }

  const { stats, nextLead, today } = await getAgentDashboard(ctx);
  return (
    <>
      <PageHeader title="Today" description={todayLabel(stats.timezone, now)} />
      <AgentDashboardView
        stats={stats}
        nextLead={nextLead}
        today={today}
        minuteOfDay={minuteOfDay(stats.timezone, now)}
        driver={dialerDriver()}
        inAppEnabled={ctx.profile.in_app_calling_enabled}
      />
    </>
  );
}

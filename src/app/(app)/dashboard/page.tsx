import type { Metadata } from "next";
import { appPageMetadata } from "@/lib/i18n/metadata";
import { PageHeader } from "@/components/common/page-header";
import { AdminDashboardView } from "@/components/dashboard/admin-dashboard";
import { AgentDashboardView } from "@/components/dashboard/agent-dashboard";
import { currentTime } from "@/components/common/datetime";
import { formatInTz, isValidTimeZone } from "@/lib/domain/time";
import { getServerWorkspace } from "@/lib/i18n/server-workspace";
import { formatDate } from "@/lib/i18n/format";
import operationsEn from "@/lib/i18n/messages/en/operations";
import operationsDe from "@/lib/i18n/messages/de/operations";
import type { Locale } from "@/lib/i18n/locales";
import { requireUserPage } from "@/server/context";
import { getDialerDriver, type DialerDriver } from "@/server/env";
import { getAdminDashboard, getAgentDashboard } from "@/server/services/dashboard";

export async function generateMetadata(): Promise<Metadata> {
  return appPageMetadata("Dashboard", "Dashboard");
}

function todayLabel(tz: string, now: number, locale: Locale): string {
  return formatDate(new Date(now), locale, { weekday: "long", month: "short", day: "numeric", timeZone: isValidTimeZone(tz) ? tz : "America/New_York" });
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
  const { locale } = await getServerWorkspace(ctx.profile.primary_locale);
  const t = locale === "de" ? operationsDe : operationsEn;
  const now = currentTime();

  if (ctx.profile.role === "ADMIN") {
    const { totals, agents, attention } = await getAdminDashboard(ctx);
    return (
      <>
        <PageHeader
          title={t.dashboardTitle}
          description={t.teamToday}
        />
        <AdminDashboardView totals={totals} agents={agents} attention={attention} driver={dialerDriver()} />
      </>
    );
  }

  const { stats, nextLead, today } = await getAgentDashboard(ctx);
  return (
    <>
      <PageHeader title={t.today} description={todayLabel(stats.timezone, now, locale)} />
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

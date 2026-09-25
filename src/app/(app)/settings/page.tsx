import type { Metadata } from "next";
import { appPageMetadata } from "@/lib/i18n/metadata";
import { PageHeader } from "@/components/common/page-header";
import { AgentTargetsList, CompanySettingsForm } from "@/components/settings/admin-settings";
import { AudioSection } from "@/components/settings/audio-section";
import { CalendarSection } from "@/components/settings/calendar-section";
import { CallModeSection } from "@/components/settings/call-mode-section";
import { PepSection } from "@/components/settings/pep-section";
import { EmailForm, NameForm, PasswordForm, type EmailChangeNotice } from "@/components/settings/profile-forms";
import { SettingsSection } from "@/components/settings/settings-section";
import { getServerWorkspace } from "@/lib/i18n/server-workspace";
import { formatNumber } from "@/lib/i18n/format";
import operationsEn from "@/lib/i18n/messages/en/operations";
import operationsDe from "@/lib/i18n/messages/de/operations";
import { requireUserPage } from "@/server/context";
import { getDialerDriver } from "@/server/env";
import { getBookableHours, getCalendarConnectionStatus, listAgentCalendars } from "@/server/services/calendar-connection";
import { getSettingsPageData } from "@/server/services/settings";

export async function generateMetadata(): Promise<Metadata> {
  return appPageMetadata("Settings", "Einstellungen");
}

function parseNotice(value: string | string[] | undefined): EmailChangeNotice {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "confirmed" || raw === "failed" || raw === "invalid" ? raw : null;
}

function inAppDriverAvailable(): boolean {
  try {
    return getDialerDriver() !== "tel";
  } catch {
    // Same fallback as the (app) layout: an invalid environment means phone calls only.
    return false;
  }
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireUserPage();
  const { locale } = await getServerWorkspace(ctx.profile.primary_locale);
  const t = locale === "de" ? operationsDe : operationsEn;
  const isAdmin = ctx.profile.role === "ADMIN";
  const [data, query, calendar] = await Promise.all([
    getSettingsPageData(ctx),
    searchParams,
    isAdmin
      ? Promise.all([getCalendarConnectionStatus(ctx), getBookableHours(ctx), listAgentCalendars(ctx)])
      : Promise.resolve(null),
  ]);
  const { profile } = data;
  const inAppAvailable = profile.inAppCallingEnabled && inAppDriverAvailable();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <PageHeader title={t.settingsTitle} className="mb-2" />

      <SettingsSection id="profile" title={t.profile}>
        <NameForm name={profile.name} />
        <EmailForm email={profile.email} notice={parseNotice(query.email_change)} />
        <div className="border-t pt-4">
          <PasswordForm />
        </div>
      </SettingsSection>

      <SettingsSection
        id="daily-target"
        title={t.dailyTarget}
        description={isAdmin ? t.changeAgentTargets : t.setByAdmin}
      >
        <p className="flex items-baseline gap-2">
          <span className="text-4xl leading-none font-extrabold tabular-nums">{formatNumber(profile.dailyCallTarget, locale)}</span>
          <span className="text-sm text-muted-foreground">{t.callsADay}</span>
        </p>
      </SettingsSection>

      <SettingsSection id="call-mode" title={t.callMode} description={t.callModeDesc}>
        <CallModeSection inAppAvailable={inAppAvailable} />
      </SettingsSection>

      <SettingsSection
        id="pep-talk"
        title={t.pepTitle}
        description={t.pepDesc}
      >
        <PepSection />
      </SettingsSection>

      <SettingsSection id="audio" title={t.audio} description={t.audioDesc}>
        <AudioSection inAppAvailable={inAppAvailable} />
      </SettingsSection>

      {data.admin && calendar ? (
        <>
          <CalendarSection
            status={calendar[0]}
            hours={calendar[1]}
            agentCalendars={calendar[2]}
            timeZone={data.admin.company.defaultTimezone}
          />
          <SettingsSection id="company" title={t.company} description={t.adminOnly}>
            <CompanySettingsForm company={data.admin.company} />
          </SettingsSection>
          <SettingsSection id="agent-targets" title={t.agentTargets} description={t.agentTargetsDesc}>
            <AgentTargetsList rows={data.admin.agentTargets} />
          </SettingsSection>
        </>
      ) : null}
    </div>
  );
}

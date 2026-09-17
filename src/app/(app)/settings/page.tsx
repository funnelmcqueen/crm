import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { AgentTargetsList, CompanySettingsForm } from "@/components/settings/admin-settings";
import { AudioSection } from "@/components/settings/audio-section";
import { CallModeSection } from "@/components/settings/call-mode-section";
import { PepSection } from "@/components/settings/pep-section";
import { EmailForm, NameForm, PasswordForm, type EmailChangeNotice } from "@/components/settings/profile-forms";
import { SettingsSection } from "@/components/settings/settings-section";
import { requireUserPage } from "@/server/context";
import { getDialerDriver } from "@/server/env";
import { getSettingsPageData } from "@/server/services/settings";

export const metadata: Metadata = {
  title: "Settings",
};

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
  const [data, query] = await Promise.all([getSettingsPageData(ctx), searchParams]);
  const { profile } = data;
  const isAdmin = data.admin !== null;
  const inAppAvailable = profile.inAppCallingEnabled && inAppDriverAvailable();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <PageHeader title="Settings" className="mb-2" />

      <SettingsSection id="profile" title="Profile">
        <NameForm name={profile.name} />
        <EmailForm email={profile.email} notice={parseNotice(query.email_change)} />
        <div className="border-t pt-4">
          <PasswordForm />
        </div>
      </SettingsSection>

      <SettingsSection
        id="daily-target"
        title="Daily target"
        description={isAdmin ? "Change agent targets under Agent targets below." : "Set by your admin."}
      >
        <p className="flex items-baseline gap-2">
          <span className="text-4xl leading-none font-extrabold tabular-nums">{profile.dailyCallTarget.toLocaleString("en-US")}</span>
          <span className="text-sm text-muted-foreground">calls a day</span>
        </p>
      </SettingsSection>

      <SettingsSection id="call-mode" title="Call mode" description="How CALL places calls on this device.">
        <CallModeSection inAppAvailable={inAppAvailable} />
      </SettingsSection>

      <SettingsSection
        id="pep-talk"
        title="Between-calls lines"
        description="A one-liner after some calls and on your dashboard. Dark, rude, and entirely optional."
      >
        <PepSection />
      </SettingsSection>

      <SettingsSection id="audio" title="Audio" description="Microphone and speaker for in-app calls.">
        <AudioSection inAppAvailable={inAppAvailable} />
      </SettingsSection>

      {data.admin ? (
        <>
          <SettingsSection id="company" title="Company" description="Admin only.">
            <CompanySettingsForm company={data.admin.company} />
          </SettingsSection>
          <SettingsSection id="agent-targets" title="Agent targets" description="Daily call target per agent. Saved per row.">
            <AgentTargetsList rows={data.admin.agentTargets} />
          </SettingsSection>
        </>
      ) : null}
    </div>
  );
}

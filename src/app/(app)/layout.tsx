import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import { VoicemailBadge } from "@/components/app-shell/voicemail-badge";
import { DialerProvider } from "@/components/dialer/dialer-provider";
import { NextLeadLink } from "@/components/dialer/next-lead-link";
import { requireUserPage } from "@/server/context";
import { getDialerDriver, type DialerDriver } from "@/server/env";
import { unheardVoicemailCount } from "@/server/services/voicemails";

function dialerDriver(): DialerDriver {
  try {
    return getDialerDriver();
  } catch (error) {
    // The message lists variable names only. Phone calls still work without a valid Twilio config.
    console.error(`[dialer] ${error instanceof Error ? error.message : "invalid server environment"}; using tel:`);
    return "tel";
  }
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Layouts are not re-run on every client navigation, so each page must also call requireUserPage().
  const ctx = await requireUserPage();
  const { profile } = ctx;
  const voicemails = await unheardVoicemailCount(ctx).catch(() => 0);

  return (
    <DialerProvider
      userId={ctx.userId}
      defaultDriver={dialerDriver()}
      inAppEnabled={profile.in_app_calling_enabled}
      timezone={profile.timezone}
    >
      <AppShell
        user={{ name: profile.name, email: profile.email, role: profile.role }}
        badges={{ "follow-ups": <VoicemailBadge userId={ctx.userId} initialCount={voicemails} /> }}
        headerSlot={profile.role === "AGENT" ? <NextLeadLink /> : undefined}
      >
        {children}
      </AppShell>
    </DialerProvider>
  );
}

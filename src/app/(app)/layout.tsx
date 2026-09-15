import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import { requireUserPage } from "@/server/context";

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Layouts are not re-run on every client navigation, so each page must also call requireUserPage().
  const { profile } = await requireUserPage();

  // Mount points for later stages:
  // - badges={{ "follow-ups": <VoicemailBadge /> }} for the unread voicemail count
  // - wrap <AppShell> in <DialerProvider driver={getDialerDriver()} ...> (getDialerDriver from @/server/env)
  return <AppShell user={{ name: profile.name, email: profile.email, role: profile.role }}>{children}</AppShell>;
}

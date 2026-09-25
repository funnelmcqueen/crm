"use client";
import type { ReactNode } from "react";
import { BottomNav } from "./bottom-nav";
import { Brand } from "./brand";
import type { NavKey, ShellUser } from "./nav-config";
import { Sidebar } from "./sidebar";
import { UserMenu } from "./user-menu";
import { useLocale } from "@/components/i18n/locale-provider";

export interface AppShellProps {
  user: ShellUser;
  /**
   * Shown after a nav item's label, e.g. the unread voicemail count on "follow-ups". Each node is
   * rendered twice (desktop sidebar and mobile tab bar, one hidden by CSS), so badges should read
   * shared client state rather than fetch on their own.
   */
  badges?: Partial<Record<NavKey, ReactNode>>;
  /** Top-right of the shell: mobile top bar and desktop sidebar header. Also rendered twice. */
  headerSlot?: ReactNode;
  children: ReactNode;
}

export function AppShell({ user, badges, headerSlot, children }: AppShellProps) {
  const { messages } = useLocale();
  return (
    <div className="min-h-dvh">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-3 focus:font-bold focus:text-primary-foreground"
      >
        {messages.skipToContent}
      </a>

      <Sidebar user={user} badges={badges} headerSlot={headerSlot} />

      <div className="flex min-h-dvh flex-col md:pl-60">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-background px-4 md:hidden">
          <Brand />
          <div className="flex items-center gap-1">
            {headerSlot ? (
              <div data-slot="shell-header-slot" className="flex items-center gap-2">
                {headerSlot}
              </div>
            ) : null}
            <UserMenu user={user} compact />
          </div>
        </header>

        <main
          id="main-content"
          className="mx-auto w-full max-w-6xl flex-1 px-4 pt-4 pb-[calc(var(--bottom-nav-height)+1.5rem)] md:px-8 md:pt-8 md:pb-10"
        >
          {children}
        </main>
      </div>

      <BottomNav role={user.role} badges={badges} />
    </div>
  );
}

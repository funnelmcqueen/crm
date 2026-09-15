"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Brand } from "./brand";
import { getNavItems, isNavItemActive, type NavKey, type ShellUser } from "./nav-config";
import { UserMenu } from "./user-menu";

export interface SidebarProps {
  user: ShellUser;
  badges?: Partial<Record<NavKey, ReactNode>>;
  headerSlot?: ReactNode;
}

/** Desktop navigation (md and up). */
export function Sidebar({ user, badges, headerSlot }: SidebarProps) {
  const pathname = usePathname();
  const items = getNavItems(user.role);

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-5">
        <Brand />
        {headerSlot ? (
          <div data-slot="shell-header-slot" className="flex items-center gap-2">
            {headerSlot}
          </div>
        ) : null}
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-2">
        <ul className="flex flex-col gap-1">
          {items.map((navItem) => {
            const active = isNavItemActive(pathname, navItem);
            const Icon = navItem.icon;
            return (
              <li key={navItem.key}>
                <Link
                  href={navItem.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-12 items-center gap-3 rounded-lg px-3 text-sm font-semibold outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_3px_0_0_var(--primary)]"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                  )}
                >
                  <Icon aria-hidden className={cn("size-5 shrink-0", active && "text-primary")} />
                  <span className="min-w-0 flex-1 truncate">{navItem.label}</span>
                  {badges?.[navItem.key] ?? null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="shrink-0 border-t border-sidebar-border p-3">
        <UserMenu user={user} />
      </div>
    </aside>
  );
}

"use client";

import { Ellipsis } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useLocale } from "@/components/i18n/locale-provider";
import { MOBILE_TAB_LIMIT, getNavItems, isNavItemActive, navLabel, type NavKey, type ShellRole } from "./nav-config";

export interface BottomNavProps {
  role: ShellRole;
  badges?: Partial<Record<NavKey, ReactNode>>;
}

const tabClass =
  "relative flex h-full min-h-12 w-full flex-col items-center justify-center gap-1 px-1 text-[11px] font-semibold outline-none transition-colors duration-150 focus-visible:bg-accent";

function ActiveBar() {
  return <span aria-hidden className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-primary" />;
}

/** Mobile navigation (below md): up to five tabs, the rest in a "More" sheet. */
export function BottomNav({ role, badges }: BottomNavProps) {
  const { locale } = useLocale();
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const items = getNavItems(role);
  const needsMore = items.length > MOBILE_TAB_LIMIT;
  const tabs = needsMore ? items.slice(0, MOBILE_TAB_LIMIT - 1) : items;
  const overflow = needsMore ? items.slice(MOBILE_TAB_LIMIT - 1) : [];
  const overflowActive = overflow.some((navItem) => isNavItemActive(pathname, navItem));

  return (
    <nav
      aria-label={locale === "de" ? "Hauptnavigation" : "Main"}
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid h-16 grid-cols-5">
        {tabs.map((navItem) => {
          const active = isNavItemActive(pathname, navItem);
          const Icon = navItem.icon;
          const badge = badges?.[navItem.key];
          return (
            <li key={navItem.key}>
              <Link
                href={navItem.href}
                aria-label={navLabel(navItem, locale)}
                aria-current={active ? "page" : undefined}
                className={cn(tabClass, active ? "text-foreground" : "text-muted-foreground")}
              >
                {active ? <ActiveBar /> : null}
                <span className="relative">
                  <Icon aria-hidden className={cn("size-5", active && "text-primary")} />
                  {badge ? <span className="absolute -top-1.5 -right-3">{badge}</span> : null}
                </span>
                <span className="max-w-full truncate">{navLabel(navItem, locale, true)}</span>
              </Link>
            </li>
          );
        })}

        {needsMore ? (
          <li>
            <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
              <SheetTrigger asChild>
                <button
                  type="button"
                  className={cn(tabClass, overflowActive ? "text-foreground" : "text-muted-foreground")}
                >
                  {overflowActive ? <ActiveBar /> : null}
                  <Ellipsis aria-hidden className={cn("size-5", overflowActive && "text-primary")} />
                  <span>{locale === "de" ? "Mehr" : "More"}</span>
                </button>
              </SheetTrigger>
              <SheetContent side="bottom" className="rounded-t-2xl pb-[calc(env(safe-area-inset-bottom)+1rem)]">
                <SheetHeader className="px-5 pt-5">
                  <SheetTitle className="text-lg font-bold">{locale === "de" ? "Mehr" : "More"}</SheetTitle>
                  <SheetDescription className="sr-only">{locale === "de" ? "Weitere Bereiche des CRM" : "Other sections of the CRM"}</SheetDescription>
                </SheetHeader>
                <ul className="flex flex-col gap-1 px-3">
                  {overflow.map((navItem) => {
                    const active = isNavItemActive(pathname, navItem);
                    const Icon = navItem.icon;
                    return (
                      <li key={navItem.key}>
                        <Link
                          href={navItem.href}
                          aria-current={active ? "page" : undefined}
                          onClick={() => setMoreOpen(false)}
                          className={cn(
                            "flex min-h-12 items-center gap-3 rounded-lg px-3 text-base font-semibold outline-none transition-colors duration-150 focus-visible:bg-accent",
                            active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
                          )}
                        >
                          <Icon aria-hidden className={cn("size-5", active && "text-primary")} />
                          <span className="flex-1">{navLabel(navItem, locale)}</span>
                          {badges?.[navItem.key] ?? null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </SheetContent>
            </Sheet>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}

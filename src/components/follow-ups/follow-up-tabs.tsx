"use client";
import Link from "next/link";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { cn } from "@/lib/utils";
import type { FollowUpCounts } from "@/server/services/follow-ups";
import { FOLLOW_UP_TABS, followUpsHref, type FollowUpTab } from "./params";

export interface FollowUpTabsProps {
  active: FollowUpTab;
  counts: FollowUpCounts;
}

/**
 * Every badge counts the rows its tab lists. The Voicemails tab lists heard and unheard voicemails
 * alike, so its badge counts both; unheard only drives the alert styling below. Counting unheard here
 * made the badge read 0 over a tab still holding every voicemail.
 */
function countFor(tab: FollowUpTab, counts: FollowUpCounts): number {
  if (tab === "voicemails") return counts.voicemailsTotal;
  if (tab === "skipped") return counts.skipped;
  return counts[tab];
}

/**
 * URL-driven tabs (links, so every tab is shareable and works without JavaScript).
 *
 * The scrolling nav is `relative` on purpose: the counts hold sr-only text, which Tailwind positions
 * absolutely. Without a positioned scroll container that text lays out against the page and widens it on
 * phones instead of being clipped here.
 */
export function FollowUpTabs({ active, counts }: FollowUpTabsProps) {
  const t = useTranslations("workspace").queues;
  const { locale } = useLocale();
  const labels = { overdue: t.overdue, today: t.today, upcoming: t.upcoming, completed: t.completed, voicemails: t.voicemails, skipped: t.skipped };
  return (
    <nav aria-label={t.navigation} className="relative -mx-4 mb-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <ul className="flex min-w-max gap-1 border-b">
        {FOLLOW_UP_TABS.map((tab) => {
          const selected = tab === active;
          const count = countFor(tab, counts);
          const unheard = tab === "voicemails" ? counts.voicemailsUnheard : 0;
          const alert = tab === "voicemails" ? unheard > 0 : count > 0 && tab === "overdue";
          return (
            <li key={tab}>
              <Link
                href={followUpsHref(tab)}
                aria-current={selected ? "page" : undefined}
                scroll={false}
                className={cn(
                  "-mb-px inline-flex min-h-12 items-center gap-2 rounded-t-lg border-b-2 px-3 text-sm font-semibold outline-none transition-colors duration-100 focus-visible:ring-3 focus-visible:ring-ring/50",
                  selected ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {labels[tab]}
                <span
                  className={cn(
                    "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-extrabold tabular-nums",
                    alert
                      ? tab === "voicemails"
                        ? "bg-primary text-primary-foreground"
                        : "bg-destructive/15 text-destructive"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {count.toLocaleString(locale === "de" ? "de-DE" : "en-US")}
                  <span className="sr-only">
                    {tab === "voicemails" ? ` ${t.voicemails}${unheard > 0 ? `, ${unheard.toLocaleString(locale === "de" ? "de-DE" : "en-US")} ${t.unheard}` : ""}` : ""}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

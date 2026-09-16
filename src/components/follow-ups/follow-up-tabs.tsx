import Link from "next/link";
import { cn } from "@/lib/utils";
import type { FollowUpCounts } from "@/server/services/follow-ups";
import { FOLLOW_UP_TAB_LABELS, FOLLOW_UP_TABS, followUpsHref, type FollowUpTab } from "./params";

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
  return (
    <nav aria-label="Follow-up lists" className="relative -mx-4 mb-4 overflow-x-auto px-4 md:mx-0 md:px-0">
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
                {FOLLOW_UP_TAB_LABELS[tab]}
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
                  {count.toLocaleString("en-US")}
                  <span className="sr-only">
                    {tab === "voicemails" ? ` voicemails${unheard > 0 ? `, ${unheard.toLocaleString("en-US")} unheard` : ""}` : ""}
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

"use client";

import Link from "next/link";
import type { CallHistoryTab } from "@/server/services/calls";
import { useTranslations } from "@/components/i18n/locale-provider";

export interface CallHistoryAgentOption {
  id: string;
  name: string;
}

export interface CallHistoryFiltersProps {
  tab: CallHistoryTab;
  isAdmin: boolean;
  agents: CallHistoryAgentOption[];
  selectedAgentId?: string;
}

export function callHistoryHref({ tab, agentId, page = 1 }: { tab: CallHistoryTab; agentId?: string; page?: number }): string {
  const params = new URLSearchParams({ tab });
  if (agentId) params.set("agent", agentId);
  if (page > 1) params.set("page", String(page));
  return `/calls?${params.toString()}`;
}

const TABS: ReadonlyArray<{ value: CallHistoryTab; label: string }> = [
  { value: "all", label: "All" },
  { value: "missed", label: "Missed" },
  { value: "voicemail", label: "Voicemail" },
];

/** Shareable, server-rendered filters. Agent selection is only rendered for admins. */
export function CallHistoryFilters({ tab, isAdmin, agents, selectedAgentId }: CallHistoryFiltersProps) {
  const t = useTranslations("workspace");
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <nav aria-label={t.callHistoryLists} className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-1 border-b">
          {TABS.map(({ value }) => {
            const selected = value === tab;
            return (
              <li key={value}>
                <Link
                  href={callHistoryHref({ tab: value, agentId: selectedAgentId })}
                  aria-current={selected ? "page" : undefined}
                  scroll={false}
                  className={`-mb-px inline-flex min-h-12 items-center rounded-t-lg border-b-2 px-3 text-sm font-semibold outline-none transition-colors duration-100 focus-visible:ring-3 focus-visible:ring-ring/50 ${
                    selected ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t.callsTabs[value]}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {isAdmin ? (
        <form action="/calls" method="get" className="flex min-w-0 gap-2">
          <input type="hidden" name="tab" value={tab} />
          <label className="sr-only" htmlFor="calls-agent-filter">
            {t.filterByAgent}
          </label>
          <select
            id="calls-agent-filter"
            name="agent"
            defaultValue={selectedAgentId ?? ""}
            className="min-h-12 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:w-52"
          >
            <option value="">{t.allAgents}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <button type="submit" className="min-h-12 rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50">
            {t.apply}
          </button>
        </form>
      ) : null}
    </div>
  );
}

"use client";

import { useTranslations } from "@/components/i18n/locale-provider";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { DisabledAgentsWithLeads } from "@/server/services/agents";
import { ReassignLeadsDialog, type ReassignTarget } from "./agent-dialogs";
import { formatCount } from "./format";

export interface DisabledAgentsBannerProps {
  disabled: DisabledAgentsWithLeads;
  reassignTargets: ReassignTarget[];
}

/** Shown while leads are still assigned to disabled agents: nobody calls those leads until they are reassigned. */
export function DisabledAgentsBanner({ disabled, reassignTargets }: DisabledAgentsBannerProps) {
  const t = useTranslations("admin");
  const [from, setFrom] = useState<{ userId: string; name: string } | null>(null);
  if (disabled.agents.length === 0) return null;

  const agentCount = disabled.agents.length;
  return (
    <section
      aria-labelledby="disabled-agents-title"
      className="mb-4 flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="min-w-0">
          <h2 id="disabled-agents-title" className="font-bold">
            <span className="tabular-nums">{formatCount(disabled.leadCount)}</span>{" "}
            {disabled.leadCount === 1 ? t["lead"] : t["leads"]} · {formatCount(agentCount)} {agentCount === 1 ? t["agent"] : t["agents"]} {t["Disabled"].toLowerCase()}
          </h2>
          <p className="text-sm text-muted-foreground">{t["Nobody is calling them. Reassign them to an active agent."]}</p>
        </div>
      </div>
      <ul className="flex flex-col divide-y divide-destructive/20 rounded-lg border border-destructive/20 bg-background/40">
        {disabled.agents.map((agent) => (
          <li key={agent.userId} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="min-w-0 truncate text-sm">
              <span className="font-semibold">{agent.name}</span>
              <span className="text-muted-foreground">
                {" "}
                · <span className="tabular-nums">{formatCount(agent.leadsAssigned)}</span>{" "}
                {agent.leadsAssigned === 1 ? t["lead"] : t["leads"]}
              </span>
            </span>
            <Button
              variant="outline"
              className="h-12 shrink-0 px-4"
              onClick={() => setFrom({ userId: agent.userId, name: agent.name })}
            >
              {t["Reassign"]}
            </Button>
          </li>
        ))}
      </ul>
      {from ? <ReassignLeadsDialog from={from} targets={reassignTargets} onClose={() => setFrom(null)} /> : null}
    </section>
  );
}

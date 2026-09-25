"use client";

import { useTranslations } from "@/components/i18n/locale-provider";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { pipelineHref, type PipelineParams } from "./params";

const ALL = "__all";
const UNASSIGNED = "__unassigned";

export interface PipelineToolbarAgent {
  id: string;
  name: string;
  active: boolean;
}

export interface PipelineToolbarProps {
  params: PipelineParams;
  isAdmin: boolean;
  /** Admin only. */
  agents: PipelineToolbarAgent[];
}

export function PipelineToolbar({ params, isAdmin, agents }: PipelineToolbarProps) {
  const t = useTranslations("operations");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function navigate(next: PipelineParams) {
    startTransition(() => {
      router.replace(pipelineHref(next), { scroll: false });
    });
  }

  const agentValue = params.unassigned ? UNASSIGNED : (params.agent ?? ALL);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2" aria-busy={pending || undefined}>
      {isAdmin ? (
        <Select
          value={agentValue}
          onValueChange={(value) =>
            navigate({
              ...params,
              unassigned: value === UNASSIGNED,
              agent: value === ALL || value === UNASSIGNED ? null : value,
            })
          }
        >
          <SelectTrigger aria-label={t.filterAgent} className="min-w-44 px-3 text-sm data-[size=default]:h-12">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={ALL} className="min-h-12">
              {t.allAgents}
            </SelectItem>
            <SelectItem value={UNASSIGNED} className="min-h-12">
              {t.unassigned}
            </SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id} className="min-h-12">
                {agent.name}
                {agent.active ? "" : ` (${t.disabled})`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      <div className="flex h-12 items-center gap-2 rounded-lg border px-3">
        <Switch
          id="pipeline-show-closed"
          checked={params.closed}
          onCheckedChange={(checked) => navigate({ ...params, closed: checked })}
        />
        <Label htmlFor="pipeline-show-closed" className="cursor-pointer text-sm">
          {t.showClosed}
        </Label>
      </div>

      <span aria-live="polite" className="text-xs text-muted-foreground">
        {pending ? t.updating : ""}
      </span>
    </div>
  );
}

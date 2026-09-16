"use client";

import { Activity, ArrowRightLeft, MoreHorizontal, Pencil, PhoneOff, PhoneCall, UserCheck, UserX } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setInAppCallingAction } from "@/server/actions/agents";
import type { AgentRow } from "@/server/services/agents";
import { EditAgentDialog, ReassignLeadsDialog, SetAgentActiveDialog, type ReassignTarget } from "./agent-dialogs";

export interface AgentRowActionsProps {
  agent: AgentRow;
  reassignTargets: ReassignTarget[];
}

type OpenDialog = "edit" | "active" | "reassign" | null;

const ITEM = "min-h-12 gap-2";

export function AgentRowActions({ agent, reassignTargets }: AgentRowActionsProps) {
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [pending, startTransition] = useTransition();

  function toggleInApp() {
    const enable = !agent.inAppCallingEnabled;
    startTransition(async () => {
      const result = await setInAppCallingAction(agent.userId, enable);
      if (result.ok) {
        toast.success(enable ? `In-app calling is on for ${agent.name}` : `${agent.name} now calls from their phone`);
      } else {
        toast.error(result.error.message);
      }
    });
  }

  const close = () => setDialog(null);

  return (
    <>
      {/* Non-modal so the dialogs opened from it get focus back cleanly. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="size-12" aria-label={`Actions for ${agent.name}`} disabled={pending}>
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="truncate text-xs text-muted-foreground">{agent.name}</DropdownMenuLabel>
          <DropdownMenuItem asChild className={ITEM}>
            <Link href={`/admin/agents/${agent.userId}`}>
              <Activity aria-hidden />
              View activity
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem className={ITEM} onSelect={() => setDialog("edit")}>
            <Pencil aria-hidden />
            Edit name, target, time zone
          </DropdownMenuItem>
          <DropdownMenuItem className={ITEM} onSelect={toggleInApp}>
            {agent.inAppCallingEnabled ? <PhoneOff aria-hidden /> : <PhoneCall aria-hidden />}
            {agent.inAppCallingEnabled ? "Turn off in-app calling" : "Turn on in-app calling"}
          </DropdownMenuItem>
          <DropdownMenuItem className={ITEM} disabled={agent.leadsAssigned === 0} onSelect={() => setDialog("reassign")}>
            <ArrowRightLeft aria-hidden />
            Reassign leads
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className={agent.active ? `${ITEM} text-destructive focus:text-destructive` : ITEM}
            onSelect={() => setDialog("active")}
          >
            {agent.active ? <UserX aria-hidden /> : <UserCheck aria-hidden />}
            {agent.active ? "Disable agent" : "Reactivate agent"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === "edit" ? <EditAgentDialog agent={agent} onClose={close} /> : null}
      {dialog === "active" ? <SetAgentActiveDialog agent={agent} onClose={close} /> : null}
      {dialog === "reassign" ? (
        <ReassignLeadsDialog from={{ userId: agent.userId, name: agent.name }} targets={reassignTargets} onClose={close} />
      ) : null}
    </>
  );
}

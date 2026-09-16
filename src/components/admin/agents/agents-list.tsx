import { PhoneOff } from "lucide-react";
import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import { cn } from "@/lib/utils";
import type { AgentRow } from "@/server/services/agents";
import type { ReassignTarget } from "./agent-dialogs";
import { AgentRowActions } from "./agent-row-actions";
import { formatCount, formatTalkTime } from "./format";

export function AgentStatusBadge({
  active,
  deleted = false,
  deletePending = false,
  className,
}: {
  active: boolean;
  deleted?: boolean;
  /** Deleted, but closing the login has not finished (D40). */
  deletePending?: boolean;
  className?: string;
}) {
  const tone = deletePending ? "warn" : deleted ? "muted" : active ? "ok" : "warn";
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold whitespace-nowrap",
        tone === "muted"
          ? "border-border bg-muted text-muted-foreground"
          : tone === "ok"
            ? "border-success/30 bg-success/10 text-foreground"
            : "border-destructive/40 bg-destructive/10 text-destructive",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          tone === "muted" ? "bg-muted-foreground" : tone === "ok" ? "bg-success" : "bg-destructive",
        )}
      />
      {deletePending ? "Delete unfinished" : deleted ? "Deleted" : active ? "Active" : "Disabled"}
    </span>
  );
}

function InAppOffNote() {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <PhoneOff aria-hidden className="size-3" />
      Phone only
    </span>
  );
}

/** "37 / 50", gold once the target is hit. */
function CallsVsTarget({ dials, target }: { dials: number; target: number }) {
  const hit = target > 0 && dials >= target;
  return (
    <span className="whitespace-nowrap tabular-nums">
      <span className={cn("font-extrabold", hit && "text-gold")}>{formatCount(dials)}</span>
      <span className="text-muted-foreground"> / {formatCount(target)}</span>
    </span>
  );
}

function Numbers({ numbers }: { numbers: string[] }) {
  if (numbers.length === 0) return <span className="text-muted-foreground">Pool</span>;
  return (
    <span className="flex flex-col tabular-nums">
      {numbers.map((n) => (
        <span key={n} className="whitespace-nowrap">
          {formatPhoneDisplay(n)}
        </span>
      ))}
    </span>
  );
}

export interface AgentsListProps {
  agents: AgentRow[];
  reassignTargets: ReassignTarget[];
}

export function AgentsTable({ agents, reassignTargets }: AgentsListProps) {
  return (
    <div className="hidden overflow-x-auto rounded-xl border bg-card md:block">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-11 pl-4">Agent</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Leads</TableHead>
            <TableHead className="text-right">Calls today</TableHead>
            <TableHead className="text-right">Talk today</TableHead>
            <TableHead className="text-right">Appts today</TableHead>
            <TableHead>Number</TableHead>
            <TableHead className="pr-4 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {agents.map((agent) => (
            <TableRow key={agent.userId} className={cn("h-16", !agent.active && "text-muted-foreground")}>
              <TableCell className="max-w-64 pl-4">
                <Link
                  href={`/admin/agents/${agent.userId}`}
                  className="block truncate font-bold text-foreground outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {agent.name}
                </Link>
                <span className="block truncate text-xs text-muted-foreground">{agent.email}</span>
              </TableCell>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <AgentStatusBadge active={agent.active} deletePending={agent.deletePending} />
                  {agent.inAppCallingEnabled ? null : <InAppOffNote />}
                </div>
              </TableCell>
              <TableCell className="text-right font-extrabold tabular-nums">{formatCount(agent.leadsAssigned)}</TableCell>
              <TableCell className="text-right">
                <CallsVsTarget dials={agent.dialsToday} target={agent.dailyCallTarget} />
              </TableCell>
              <TableCell className="text-right font-extrabold tabular-nums">{formatTalkTime(agent.talkSecondsToday)}</TableCell>
              <TableCell className="text-right font-extrabold tabular-nums">{formatCount(agent.appointmentsToday)}</TableCell>
              <TableCell className="text-sm">
                <Numbers numbers={agent.assignedNumbers} />
              </TableCell>
              <TableCell className="pr-4 text-right">
                <AgentRowActions agent={agent} reassignTargets={reassignTargets} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function AgentCards({ agents, reassignTargets }: AgentsListProps) {
  return (
    <ul className="flex flex-col gap-2 md:hidden">
      {agents.map((agent) => (
        <li key={agent.userId} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <Link
              href={`/admin/agents/${agent.userId}`}
              className="flex min-h-12 min-w-0 flex-col justify-center rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <p className="truncate text-base font-bold">{agent.name}</p>
              <p className="truncate text-sm text-muted-foreground">{agent.email}</p>
            </Link>
            <AgentRowActions agent={agent} reassignTargets={reassignTargets} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AgentStatusBadge active={agent.active} deletePending={agent.deletePending} />
            {agent.inAppCallingEnabled ? null : <InAppOffNote />}
          </div>
          <dl className="grid grid-cols-4 gap-2 border-t pt-3 text-center">
            <div>
              <dt className="text-xs text-muted-foreground">Calls</dt>
              <dd className="text-sm">
                <CallsVsTarget dials={agent.dialsToday} target={agent.dailyCallTarget} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Talk</dt>
              <dd className="text-sm font-extrabold tabular-nums">{formatTalkTime(agent.talkSecondsToday)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Appts</dt>
              <dd className="text-sm font-extrabold tabular-nums">{formatCount(agent.appointmentsToday)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Leads</dt>
              <dd className="text-sm font-extrabold tabular-nums">{formatCount(agent.leadsAssigned)}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            Number: <Numbers numbers={agent.assignedNumbers} />
          </p>
        </li>
      ))}
    </ul>
  );
}

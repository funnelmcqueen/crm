"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import { DateTime } from "@/components/common/datetime";
import { StatusBadge } from "@/components/common/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import type { LeadListRow } from "@/server/services/leads";
import { FollowUpCell, locationLabel } from "./lead-list-cells";

export interface LeadsTableProps {
  rows: LeadListRow[];
  tz: string;
  now: number;
  /** Admin only: agent id -> name. Null hides the Agent column. */
  agentNames: Record<string, string> | null;
}

/** Desktop (md+) leads table. Each row opens the lead; the business name is the keyboard target. */
export function LeadsTable({ rows, tz, now, agentNames }: LeadsTableProps) {
  const router = useRouter();

  function openRow(event: MouseEvent<HTMLTableRowElement>, id: string) {
    if (event.defaultPrevented || (event.target as HTMLElement).closest("a, button")) return;
    if (event.metaKey || event.ctrlKey) {
      window.open(`/leads/${id}`, "_blank", "noopener");
      return;
    }
    router.push(`/leads/${id}`);
  }

  return (
    <div className="hidden overflow-x-auto rounded-xl border bg-card md:block">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-11 pl-4">Business</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead className="hidden min-[1440px]:table-cell">Location</TableHead>
            <TableHead>Status</TableHead>
            {agentNames ? <TableHead>Agent</TableHead> : null}
            <TableHead>Last contacted</TableHead>
            <TableHead>Next follow-up</TableHead>
            <TableHead className="pr-4 text-right">Calls</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.id}
              onClick={(event) => openRow(event, row.id)}
              className="h-14 cursor-pointer transition-colors duration-100"
            >
              <TableCell className="max-w-72 pl-4">
                <Link
                  href={`/leads/${row.id}`}
                  className="block truncate font-bold outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {row.businessName}
                </Link>
                {row.contactName ? (
                  <span className="block truncate text-xs text-muted-foreground">{row.contactName}</span>
                ) : null}
                {locationLabel(row.city, row.state) ? (
                  <span className="block truncate text-xs text-muted-foreground min-[1440px]:hidden">
                    {locationLabel(row.city, row.state)}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">{formatPhoneDisplay(row.phone)}</TableCell>
              <TableCell className="hidden max-w-44 truncate text-muted-foreground min-[1440px]:table-cell">
                {locationLabel(row.city, row.state) || "—"}
              </TableCell>
              <TableCell>
                <StatusBadge status={row.status} />
              </TableCell>
              {agentNames ? (
                <TableCell className="max-w-40 truncate">
                  {row.assignedTo ? (
                    (agentNames[row.assignedTo] ?? "Unknown")
                  ) : (
                    <span className="text-muted-foreground">Unassigned</span>
                  )}
                </TableCell>
              ) : null}
              <TableCell className="whitespace-nowrap text-muted-foreground">
                <DateTime value={row.lastContactedAt} tz={tz} now={now} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <FollowUpCell value={row.nextFollowUpAt} tz={tz} now={now} />
              </TableCell>
              <TableCell className="pr-4 text-right font-extrabold tabular-nums">{row.callCount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

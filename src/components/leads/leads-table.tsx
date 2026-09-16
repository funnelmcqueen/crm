"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import { DateTime } from "@/components/common/datetime";
import { StatusBadge } from "@/components/common/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import type { LeadListRow } from "@/server/services/leads";
import { LeadSelectCheckbox, LeadSelectPageCheckbox, useLeadSelectionContext } from "./bulk/selection-context";
import { FollowUpCell, locationLabel } from "./lead-list-cells";

export interface LeadsTableProps {
  rows: LeadListRow[];
  tz: string;
  now: number;
  /** Admin only: agent id -> name. Null hides the Agent column. */
  agentNames: Record<string, string> | null;
}

/**
 * Desktop (md+) leads table. Each row opens the lead; the business name is the keyboard target. The first column
 * selects rows for bulk actions (docs/DEVIATIONS.md D41); clicks in that cell never open the lead.
 */
export function LeadsTable({ rows, tz, now, agentNames }: LeadsTableProps) {
  const router = useRouter();
  const { ids: selected } = useLeadSelectionContext();

  function openRow(event: MouseEvent<HTMLTableRowElement>, id: string) {
    if (event.defaultPrevented || (event.target as HTMLElement).closest("a, button, [data-select-cell]")) return;
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
            <TableHead className="h-11 w-10 pr-0 pl-4" data-select-cell>
              <LeadSelectPageCheckbox />
            </TableHead>
            <TableHead className="h-11 pl-3">Business</TableHead>
            <TableHead>Phone</TableHead>
            {/* SPEC 8 lists location among the desktop columns with no width condition. */}
            <TableHead>Location</TableHead>
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
              data-state={selected.has(row.id) ? "selected" : undefined}
              className="h-14 cursor-pointer transition-colors duration-100"
            >
              <TableCell className="w-10 pr-0 pl-4" data-select-cell>
                <LeadSelectCheckbox leadId={row.id} businessName={row.businessName} />
              </TableCell>
              <TableCell className="max-w-64 pl-3">
                <Link
                  href={`/leads/${row.id}`}
                  className="block truncate font-bold outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {row.businessName}
                </Link>
                {row.contactName ? (
                  <span className="block truncate text-xs text-muted-foreground">{row.contactName}</span>
                ) : null}
              </TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">{formatPhoneDisplay(row.phone)}</TableCell>
              <TableCell className="max-w-44 truncate text-muted-foreground">
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

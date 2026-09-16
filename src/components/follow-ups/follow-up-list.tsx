"use client";

import Link from "next/link";
import { useOptimistic, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { DateTime } from "@/components/common/datetime";
import { CallButton } from "@/components/dialer/call-button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DialableLead } from "@/lib/dialer/types";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import { completeFollowUpAction } from "@/server/actions/follow-ups";
import type { FollowUpRow } from "@/server/services/follow-ups";
import { DueLabel } from "./due-label";
import { CompleteButton, RescheduleMenu } from "./follow-up-actions";
import type { FollowUpListTab } from "./params";

export interface FollowUpListProps {
  rows: FollowUpRow[];
  tab: FollowUpListTab;
  tz: string;
  now: number;
  isAdmin: boolean;
  /** Shown when the last row on the page was just completed. */
  empty: ReactNode;
}

function dialable(row: FollowUpRow): DialableLead {
  return {
    id: row.leadId,
    businessName: row.businessName,
    contactName: row.contactName,
    phone: row.phone,
    status: row.leadStatus,
  };
}

const LINK_CLASS =
  "block truncate font-bold outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Table from xl and cards below it. Three full-size actions (CALL, Complete, Reschedule) need about 370px, so a
 * table at md/lg (next to the sidebar) cut off Reschedule. Below 2xl, phone and agent sit under the business name
 * instead of in their own columns. COMPLETE removes the row at once and restores it if the save fails.
 */
export function FollowUpList({ rows, tab, tz, now, isAdmin, empty }: FollowUpListProps) {
  const [visibleRows, hideRow] = useOptimistic(rows, (state: FollowUpRow[], id: string) => state.filter((row) => row.id !== id));
  const [, startTransition] = useTransition();
  const open = tab !== "completed";

  function complete(row: FollowUpRow) {
    startTransition(async () => {
      hideRow(row.id);
      const result = await completeFollowUpAction(row.id);
      if (result.ok) toast.success(`Follow-up completed: ${row.businessName}`);
      else toast.error(result.error.message);
    });
  }

  if (visibleRows.length === 0) return <>{empty}</>;

  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border bg-card xl:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-11 pl-4">Business</TableHead>
              <TableHead className="hidden 2xl:table-cell">Phone</TableHead>
              <TableHead>{open ? "Due" : "Completed"}</TableHead>
              <TableHead>Note</TableHead>
              {isAdmin ? <TableHead className="hidden 2xl:table-cell">Agent</TableHead> : null}
              {open ? (
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRows.map((row) => (
              <TableRow key={row.id} className="transition-colors duration-100">
                <TableCell className="max-w-64 py-3 pl-4">
                  <Link href={`/leads/${row.leadId}`} className={LINK_CLASS}>
                    {row.businessName}
                  </Link>
                  {row.contactName ? (
                    <span className="block truncate text-xs text-muted-foreground">{row.contactName}</span>
                  ) : null}
                  <span className="block truncate text-xs text-muted-foreground tabular-nums 2xl:hidden">
                    {formatPhoneDisplay(row.phone)}
                  </span>
                  {isAdmin ? (
                    <span className="block truncate text-xs text-muted-foreground 2xl:hidden">
                      Agent: <span className="text-foreground">{row.ownerName ?? "Unknown"}</span>
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="hidden whitespace-nowrap tabular-nums 2xl:table-cell">{formatPhoneDisplay(row.phone)}</TableCell>
                <TableCell>
                  {open ? (
                    <DueLabel dueAt={row.dueAt} tz={tz} now={now} />
                  ) : (
                    <span className="flex flex-col gap-0.5">
                      <DateTime value={row.completedAt} tz={tz} now={now} className="text-sm whitespace-nowrap" />
                      <span className="text-xs whitespace-nowrap text-muted-foreground">
                        Due <DateTime value={row.dueAt} tz={tz} now={now} />
                      </span>
                    </span>
                  )}
                </TableCell>
                <TableCell className="max-w-72 min-w-36 whitespace-normal">
                  {row.note ? (
                    <p className="line-clamp-2 text-sm break-words" title={row.note}>
                      {row.note}
                    </p>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                {isAdmin ? (
                  <TableCell className="hidden max-w-40 truncate 2xl:table-cell">{row.ownerName ?? "Unknown"}</TableCell>
                ) : null}
                {open ? (
                  <TableCell className="py-3 pr-4">
                    <div className="flex items-center justify-end gap-2">
                      <CallButton lead={dialable(row)} />
                      <CompleteButton businessName={row.businessName} onComplete={() => complete(row)} />
                      <RescheduleMenu followUpId={row.id} businessName={row.businessName} tz={tz} />
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:hidden">
        {visibleRows.map((row) => (
          <li key={row.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={`/leads/${row.leadId}`} className={`${LINK_CLASS} text-base`}>
                  {row.businessName}
                </Link>
                <p className="truncate text-sm text-muted-foreground tabular-nums">
                  {[row.contactName, formatPhoneDisplay(row.phone)].filter(Boolean).join(" · ")}
                </p>
              </div>
              {open ? (
                <DueLabel dueAt={row.dueAt} tz={tz} now={now} align="end" className="shrink-0" />
              ) : (
                <span className="flex shrink-0 flex-col items-end text-right text-xs text-muted-foreground">
                  Completed
                  <DateTime value={row.completedAt} tz={tz} now={now} className="text-sm text-foreground" />
                </span>
              )}
            </div>
            {row.note ? <p className="line-clamp-3 text-sm break-words">{row.note}</p> : null}
            {isAdmin ? (
              <p className="truncate text-xs text-muted-foreground">
                Agent: <span className="text-foreground">{row.ownerName ?? "Unknown"}</span>
              </p>
            ) : null}
            {open ? (
              <div className="mt-auto grid grid-cols-2 gap-2">
                <CallButton lead={dialable(row)} className="col-span-2 w-full" />
                <CompleteButton businessName={row.businessName} onComplete={() => complete(row)} className="w-full" />
                <RescheduleMenu followUpId={row.id} businessName={row.businessName} tz={tz} className="w-full" />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

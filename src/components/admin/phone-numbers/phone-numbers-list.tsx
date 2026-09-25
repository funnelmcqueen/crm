"use client";

import { useTranslations } from "@/components/i18n/locale-provider";
import { DateTime } from "@/components/common/datetime";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import { cn } from "@/lib/utils";
import type { AssignableAgent, PhoneNumberListRow } from "@/server/services/phone-numbers";
import { NumberActions } from "./number-actions";

export interface PhoneNumbersListProps {
  rows: PhoneNumberListRow[];
  agents: AssignableAgent[];
  tz: string;
  now: number;
}

function ActivePill({ active }: { active: boolean }) {
  const t = useTranslations("admin");
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold whitespace-nowrap",
        active ? "border-success/30 bg-success/10 text-foreground" : "border-border bg-transparent text-muted-foreground",
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", active ? "bg-success" : "bg-muted-foreground/60")} />
      {active ? t["Active"] : t["Inactive"]}
    </span>
  );
}

function Assignee({ row }: { row: PhoneNumberListRow }) {
  const t = useTranslations("admin");
  if (!row.assignedTo) return <span className="font-semibold text-muted-foreground">{t["Pool"]}</span>;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-semibold">{row.assignedName ?? t["Unknown agent"]}</span>
      {row.assignedActive === false ? (
        // The number keeps its assignment so reactivating the agent restores it, but nobody can call
        // from it and it is not in the pool either.
        <span className="text-xs font-semibold text-destructive">{t["Disabled agent · number unused"]}</span>
      ) : null}
    </span>
  );
}

/** Desktop table (md+) and mobile cards of the admin's Twilio numbers. */
export function PhoneNumbersList({ rows, agents, tz, now }: PhoneNumbersListProps) {
  const t = useTranslations("admin");
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border bg-card md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-11 pl-4">{t["Number"]}</TableHead>
              <TableHead>{t["Label"]}</TableHead>
              <TableHead>{t["Assigned to"]}</TableHead>
              <TableHead>{t["Status"]}</TableHead>
              <TableHead className="text-right">{t["Calls today"]}</TableHead>
              <TableHead>{t["Last used"]}</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">{t["Actions"]}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className={cn("h-16", !row.active && "text-muted-foreground")}>
                <TableCell className="pl-4 font-bold whitespace-nowrap tabular-nums">{formatPhoneDisplay(row.e164)}</TableCell>
                <TableCell className="max-w-56 truncate">{row.label ?? <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className="max-w-48 truncate">
                  <Assignee row={row} />
                </TableCell>
                <TableCell>
                  <ActivePill active={row.active} />
                </TableCell>
                <TableCell className="text-right text-base font-extrabold tabular-nums">{row.callsToday}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <DateTime value={row.lastUsedAt} tz={tz} now={now} empty={t["Never"]} />
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <NumberActions number={row} agents={agents} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={cn("truncate text-base font-bold tabular-nums", !row.active && "text-muted-foreground")}>
                  {formatPhoneDisplay(row.e164)}
                </p>
                {row.label ? <p className="truncate text-sm text-muted-foreground">{row.label}</p> : null}
              </div>
              <ActivePill active={row.active} />
            </div>
            <dl className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t["Agent"]}</dt>
              <dd className="truncate">
                <Assignee row={row} />
              </dd>
              <dd className="row-span-2 flex flex-col items-end justify-center">
                <span className="text-lg leading-none font-extrabold tabular-nums">{row.callsToday}</span>
                <span className="text-xs text-muted-foreground">{t["Today"].toLowerCase()}</span>
              </dd>
              <dt className="text-muted-foreground">{t["Last used"]}</dt>
              <dd className="truncate text-muted-foreground">
                <DateTime value={row.lastUsedAt} tz={tz} now={now} empty={t["Never"]} />
              </dd>
            </dl>
            <NumberActions number={row} agents={agents} className="w-full justify-center" />
          </li>
        ))}
      </ul>
    </>
  );
}

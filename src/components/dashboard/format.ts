import { formatTalkTime } from "@/components/common/format";
import type { TeamTotals } from "@/server/services/dashboard";

export { formatTalkTime };

/** Percentage of the daily target reached, clamped to 0..100. A zero target shows an empty bar. */
export function targetPercent(dials: number, target: number): number {
  if (!Number.isFinite(dials) || !Number.isFinite(target) || target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((dials / target) * 100)));
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export interface TeamTotalItem {
  label: string;
  value: string;
  sub?: string;
}

/**
 * The admin dashboard's team tiles. Pure, so the numbers can be checked against the per-agent rows
 * rendered right below them without rendering the page.
 *
 * Two of them have to agree with other surfaces:
 *   * Talk time uses formatTalkTime, the same helper (and the same flooring) as the Talk time column
 *     in the rows underneath. Rounding the minutes here made the tile impossible to reconcile with
 *     the rows, and counted an agent with 45s as a whole minute.
 *   * Clients shows the assigned count, which is what the per-agent rows and the Reports total mean
 *     by "Clients". Unassigned client leads are still surfaced, as a sub-line, rather than folded
 *     into a number that no other screen agrees with.
 */
export function teamTotalsItems(totals: TeamTotals): TeamTotalItem[] {
  return [
    {
      label: "Leads",
      value: formatCount(totals.leadsTotal),
      sub: totals.leadsUnassigned > 0 ? `${formatCount(totals.leadsUnassigned)} unassigned` : undefined,
    },
    { label: "Calls today", value: formatCount(totals.callsToday) },
    { label: "Connected", value: formatCount(totals.connectedToday) },
    { label: "Interested", value: formatCount(totals.interestedToday) },
    { label: "Appointments", value: formatCount(totals.appointmentsToday) },
    {
      label: "Clients",
      value: formatCount(totals.clientsAssigned),
      sub: totals.clientsUnassigned > 0 ? `${formatCount(totals.clientsUnassigned)} unassigned` : undefined,
    },
    { label: "Talk time", value: formatTalkTime(totals.talkSecondsToday) },
  ];
}

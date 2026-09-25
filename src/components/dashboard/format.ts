import { formatTalkTime } from "@/components/common/format";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import operationsEn from "@/lib/i18n/messages/en/operations";
import operationsDe from "@/lib/i18n/messages/de/operations";
import type { TeamTotals } from "@/server/services/dashboard";

export { formatTalkTime };

/** Percentage of the daily target reached, clamped to 0..100. A zero target shows an empty bar. */
export function targetPercent(dials: number, target: number): number {
  if (!Number.isFinite(dials) || !Number.isFinite(target) || target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((dials / target) * 100)));
}

export function formatCount(value: number, locale: Locale = "en"): string {
  return formatNumber(value, locale);
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
export function teamTotalsItems(totals: TeamTotals, locale: Locale = "en"): TeamTotalItem[] {
  const t = locale === "de" ? operationsDe : operationsEn;
  const count = (value: number) => formatCount(value, locale);
  return [
    {
      label: t.leads,
      value: count(totals.leadsTotal),
      sub: totals.leadsUnassigned > 0 ? `${count(totals.leadsUnassigned)} ${t.unassigned.toLowerCase()}` : undefined,
    },
    { label: t.callsToday, value: count(totals.callsToday) },
    { label: t.connected, value: count(totals.connectedToday) },
    { label: t.interested, value: count(totals.interestedToday) },
    { label: t.appointments, value: count(totals.appointmentsToday) },
    {
      label: t.clients,
      value: count(totals.clientsAssigned),
      sub: totals.clientsUnassigned > 0 ? `${count(totals.clientsUnassigned)} ${t.unassigned.toLowerCase()}` : undefined,
    },
    { label: t.talkTime, value: formatTalkTime(totals.talkSecondsToday) },
  ];
}

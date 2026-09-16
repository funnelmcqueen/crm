import { Phone } from "lucide-react";
import Link from "next/link";
import { DateTime } from "@/components/common/datetime";
import { StatusBadge } from "@/components/common/status-badge";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import type { LeadListRow } from "@/server/services/leads";
import { LeadSelectCheckbox } from "./bulk/selection-context";
import { FollowUpCell, locationLabel } from "./lead-list-cells";

export interface LeadCardsProps {
  rows: LeadListRow[];
  tz: string;
  now: number;
  /** Admin only: agent id -> name. */
  agentNames: Record<string, string> | null;
}

/** Mobile (below md) lead cards. The card is the link; the checkbox beside it selects the lead for bulk actions. */
export function LeadCards({ rows, tz, now, agentNames }: LeadCardsProps) {
  return (
    <ul className="flex flex-col gap-2 md:hidden">
      {rows.map((row) => {
        const location = locationLabel(row.city, row.state);
        const subtitle = [row.contactName, location].filter(Boolean).join(" · ");
        return (
          <li key={row.id} className="flex items-stretch gap-1">
            <div className="flex w-10 shrink-0 items-start justify-center pt-5">
              <LeadSelectCheckbox leadId={row.id} businessName={row.businessName} />
            </div>
            <Link
              href={`/leads/${row.id}`}
              className="flex min-w-0 flex-1 flex-col gap-2 rounded-xl border bg-card p-4 outline-none transition-colors duration-100 active:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-bold">{row.businessName}</p>
                  {subtitle ? <p className="truncate text-sm text-muted-foreground">{subtitle}</p> : null}
                </div>
                <StatusBadge status={row.status} />
              </div>

              <p className="flex items-center gap-2 text-sm tabular-nums">
                <Phone aria-hidden className="size-4 text-muted-foreground" />
                {formatPhoneDisplay(row.phone)}
              </p>

              <dl className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Next</dt>
                <dd className="truncate">
                  <FollowUpCell value={row.nextFollowUpAt} tz={tz} now={now} />
                </dd>
                <dd className="row-span-2 flex flex-col items-end justify-center">
                  <span className="text-lg leading-none font-extrabold tabular-nums">{row.callCount}</span>
                  <span className="text-muted-foreground">{row.callCount === 1 ? "call" : "calls"}</span>
                </dd>
                <dt className="text-muted-foreground">Last</dt>
                <dd className="truncate text-muted-foreground">
                  <DateTime value={row.lastContactedAt} tz={tz} now={now} empty="Never" />
                </dd>
              </dl>

              {agentNames ? (
                <p className="truncate text-xs text-muted-foreground">
                  Agent:{" "}
                  <span className="text-foreground">
                    {row.assignedTo ? (agentNames[row.assignedTo] ?? "Unknown") : "Unassigned"}
                  </span>
                </p>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

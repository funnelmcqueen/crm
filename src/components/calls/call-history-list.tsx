import { PhoneIncoming, PhoneOutgoing, Voicemail } from "lucide-react";
import Link from "next/link";
import { DateTime, formatDuration } from "@/components/common/datetime";
import { CallButton } from "@/components/dialer/call-button";
import { ManualCallbackButton } from "@/components/calls/manual-callback-button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OUTCOME_LABELS } from "@/lib/domain/outcomes";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import type { CallHistoryRow } from "@/server/services/calls";

export interface CallHistoryListProps {
  rows: CallHistoryRow[];
  tz: string;
  now: number;
  isAdmin: boolean;
}

function titleFor(row: CallHistoryRow): string {
  return row.businessName ?? row.contactName ?? "Unknown caller";
}

function resultFor(row: CallHistoryRow): string {
  if (row.hasVoicemail) {
    const duration = row.voicemailDurationSeconds === null ? "" : ` · ${formatDuration(row.voicemailDurationSeconds)}`;
    return `${row.handledAt ? "Heard" : "Unheard"} voicemail${duration}`;
  }
  if (row.outcome) return OUTCOME_LABELS[row.outcome];
  if (row.callStatus === "no-answer") return "No answer";
  if (row.callStatus === "busy") return "Busy";
  if (row.callStatus === "failed") return "Failed";
  if (row.callStatus === "canceled") return "Canceled";
  if (row.callStatus === "completed") return "Completed";
  return "In progress";
}

function Direction({ row }: { row: CallHistoryRow }) {
  return row.direction === "INBOUND" ? (
    <span className="inline-flex items-center gap-1 text-sm font-semibold"><PhoneIncoming aria-hidden className="size-4 text-sky-600" />Incoming</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-sm font-semibold"><PhoneOutgoing aria-hidden className="size-4 text-emerald-600" />Outgoing</span>
  );
}

function Caller({ row, mobile = false }: { row: CallHistoryRow; mobile?: boolean }) {
  const phone = row.remoteE164 ? formatPhoneDisplay(row.remoteE164) : null;
  const name = titleFor(row);
  const linkClass = `${mobile ? "-my-3 py-3 text-base" : ""} block truncate font-bold outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50`;
  return (
    <div className="min-w-0">
      {row.leadId ? <Link href={`/leads/${row.leadId}`} className={linkClass}>{name}</Link> : <p className="truncate font-bold">{name}</p>}
      <p className="truncate text-xs text-muted-foreground tabular-nums">{[row.contactName && row.businessName ? row.contactName : null, phone].filter(Boolean).join(" · ") || "No phone number"}</p>
    </div>
  );
}

function Callback({ row }: { row: CallHistoryRow }) {
  if (!row.remoteE164) return null;
  if (!row.leadId || !row.leadStatus) return <ManualCallbackButton phone={row.remoteE164} />;
  return (
    <CallButton
      lead={{ id: row.leadId, businessName: titleFor(row), contactName: row.contactName, phone: row.remoteE164, status: row.leadStatus }}
      label="Call back"
      className="w-full md:w-auto"
    />
  );
}

/** Desktop table from xl; compact cards below it preserve every call fact and the callback target. */
export function CallHistoryList({ rows, tz, now, isAdmin }: CallHistoryListProps) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border bg-card xl:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-11 pl-4">Direction</TableHead>
              <TableHead>Caller / lead</TableHead>
              {isAdmin ? <TableHead>Agent</TableHead> : null}
              <TableHead>Time</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead className="pr-4 text-right"><span className="sr-only">Call back</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="py-3 pl-4"><Direction row={row} /></TableCell>
                <TableCell className="max-w-64 py-3"><Caller row={row} /></TableCell>
                {isAdmin ? <TableCell className="max-w-40 truncate">{row.agentName ?? "Unknown"}</TableCell> : null}
                <TableCell><DateTime value={row.createdAt} tz={tz} now={now} className="text-sm whitespace-nowrap" /></TableCell>
                <TableCell><span className="inline-flex items-center gap-1 text-sm">{row.hasVoicemail ? <Voicemail aria-hidden className="size-4" /> : null}{resultFor(row)}</span></TableCell>
                <TableCell className="tabular-nums">{formatDuration(row.durationSeconds)}</TableCell>
                <TableCell className="py-3 pr-4 text-right"><Callback row={row} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:hidden">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <Caller row={row} mobile />
              <span className="shrink-0 text-right text-xs text-muted-foreground"><DateTime value={row.createdAt} tz={tz} now={now} className="block text-sm text-foreground" /></span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
              <span><Direction row={row} /></span>
              <span className="truncate text-center">{resultFor(row)}</span>
              <span className="text-right tabular-nums">{formatDuration(row.durationSeconds)}</span>
            </div>
            {isAdmin ? <p className="truncate text-xs text-muted-foreground">Agent: <span className="text-foreground">{row.agentName ?? "Unknown"}</span></p> : null}
            <div className="mt-auto"><Callback row={row} /></div>
          </li>
        ))}
      </ul>
    </>
  );
}
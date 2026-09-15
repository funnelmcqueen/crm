import { PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { DateTime, formatDuration } from "@/components/common/datetime";
import { EmptyState } from "@/components/common/empty-state";
import { OUTCOME_LABELS, isCallOutcome } from "@/lib/domain/outcomes";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import type { CallHistoryEntry } from "@/server/services/leads";
import { VoicemailPlayer } from "./voicemail-player";

const CALL_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  ringing: "Ringing",
  "in-progress": "In progress",
  completed: "Completed, not logged",
  busy: "Busy",
  "no-answer": "No answer",
  failed: "Failed",
  canceled: "Canceled",
};

function callTitle(call: CallHistoryEntry): string {
  if (call.outcome && isCallOutcome(call.outcome)) return OUTCOME_LABELS[call.outcome];
  if (call.hasVoicemail) return "Voicemail left";
  if (call.callStatus) return CALL_STATUS_LABELS[call.callStatus] ?? "Not logged";
  return "Not logged";
}

export interface CallHistoryProps {
  history: CallHistoryEntry[];
  tz: string;
  now: number;
  isAdmin: boolean;
  /** False for an admin viewing an agent's lead: playing a voicemail leaves it unheard for the agent. */
  canMarkHeard: boolean;
}

export function CallHistory({ history, tz, now, isAdmin, canMarkHeard }: CallHistoryProps) {
  if (history.length === 0) {
    return <EmptyState title="No calls yet" description="Calls and voicemails for this lead show up here." className="py-8" />;
  }

  return (
    <ol className="flex flex-col divide-y">
      {history.map((call) => {
        const inbound = call.direction === "INBOUND";
        const Icon = inbound ? PhoneIncoming : PhoneOutgoing;
        const meta = [
          inbound ? "Inbound" : "Outbound",
          call.mode === "IN_APP" ? "In-app" : "Phone",
          call.durationSeconds !== null ? formatDuration(call.durationSeconds) : null,
        ].filter(Boolean);

        return (
          <li key={call.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
            <span
              className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
              title={inbound ? "Inbound call" : "Outbound call"}
            >
              <Icon aria-hidden className="size-4" />
              <span className="sr-only">{inbound ? "Inbound call" : "Outbound call"}</span>
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="font-bold">{callTitle(call)}</p>
                <DateTime value={call.createdAt} tz={tz} now={now} className="text-xs text-muted-foreground" />
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">{meta.join(" · ")}</p>
              {isAdmin && call.caller ? (
                <p className="text-xs text-muted-foreground">
                  {call.caller.name ? (
                    <>
                      {inbound ? "Routed to" : "Called by"} <span className="text-foreground">{call.caller.name}</span>
                    </>
                  ) : (
                    "No agent"
                  )}
                  {call.caller.callerIdE164 ? (
                    <>
                      {" · "}
                      {inbound ? "Line" : "Caller ID"}{" "}
                      <span className="text-foreground tabular-nums">{formatPhoneDisplay(call.caller.callerIdE164)}</span>
                    </>
                  ) : null}
                </p>
              ) : null}
              {call.notes ? <p className="text-sm break-words whitespace-pre-wrap">{call.notes}</p> : null}
              {call.hasVoicemail ? (
                <div className="mt-1">
                  <VoicemailPlayer callId={call.id} unheard={call.handledAt === null} canMarkHeard={canMarkHeard} />
                  {call.voicemailDurationSeconds !== null ? (
                    <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                      Length {formatDuration(call.voicemailDurationSeconds)}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

"use client";
import { PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { DateTime, formatDuration } from "@/components/common/datetime";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { EmptyState } from "@/components/common/empty-state";
import { isCallOutcome } from "@/lib/domain/outcomes";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import type { CallHistoryEntry } from "@/server/services/leads";
import { VoicemailPlayer } from "./voicemail-player";

function callTitle(call: CallHistoryEntry, t: ReturnType<typeof useTranslations>): string {
  if (call.outcome && isCallOutcome(call.outcome)) return t.outcomes[call.outcome];
  if (call.hasVoicemail) return t.leadHistory.voicemailLeft;
  const statuses: Record<string, string> = { queued: t.leadHistory.queued, ringing: t.leadHistory.ringing, "in-progress": t.leadHistory.inProgress, completed: t.leadHistory.completedNotLogged, busy: t.leadHistory.busy, "no-answer": t.leadHistory.noAnswer, failed: t.leadHistory.failed, canceled: t.leadHistory.canceled };
  return call.callStatus ? statuses[call.callStatus] ?? t.leadHistory.notLogged : t.leadHistory.notLogged;
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
  const { locale } = useLocale();
  const t = useTranslations("workspace");
  if (history.length === 0) {
    return <EmptyState title={t.leadHistory.noCalls} description={t.leadHistory.empty} className="py-8" />;
  }

  return (
    <ol className="flex flex-col divide-y">
      {history.map((call) => {
        const inbound = call.direction === "INBOUND";
        const Icon = inbound ? PhoneIncoming : PhoneOutgoing;
        const meta = [
          inbound ? t.leadHistory.inbound : t.leadHistory.outbound,
          call.mode === "IN_APP" ? t.leadHistory.inApp : t.leadHistory.phone,
          call.durationSeconds !== null ? formatDuration(call.durationSeconds) : null,
        ].filter(Boolean);

        return (
          <li key={call.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
            <span
              className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
              title={inbound ? t.leadHistory.inboundCall : t.leadHistory.outboundCall}
            >
              <Icon aria-hidden className="size-4" />
              <span className="sr-only">{inbound ? t.leadHistory.inboundCall : t.leadHistory.outboundCall}</span>
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="font-bold">{callTitle(call, t)}</p>
                <DateTime value={call.createdAt} tz={tz} now={now} locale={locale} className="text-xs text-muted-foreground" />
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">{meta.join(" · ")}</p>
              {isAdmin && call.caller ? (
                <p className="text-xs text-muted-foreground">
                  {call.caller.name ? (
                    <>
                      {inbound ? t.leadHistory.routedTo : t.leadHistory.calledBy} <span className="text-foreground">{call.caller.name}</span>
                    </>
                  ) : (
                    t.leadHistory.noAgent
                  )}
                  {call.caller.callerIdE164 ? (
                    <>
                      {" · "}
                      {inbound ? t.leadHistory.line : t.leadHistory.callerId}{" "}
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
                      {t.leadHistory.length} {formatDuration(call.voicemailDurationSeconds)}
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

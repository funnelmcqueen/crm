import { Phone } from "lucide-react";
import Link from "next/link";
import { DateTime, formatDuration } from "@/components/common/datetime";
import { CallButton } from "@/components/dialer/call-button";
import { VoicemailPlayer } from "@/components/leads/voicemail-player";
import { telHref } from "@/lib/dialer/resolve-mode";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import type { VoicemailRow } from "@/server/services/follow-ups";

export interface VoicemailListProps {
  rows: VoicemailRow[];
  tz: string;
  now: number;
}

const TEL_CLASS =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-base font-extrabold tracking-wide text-primary-foreground uppercase outline-none transition-colors duration-150 select-none hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background md:w-auto [&_svg]:size-5";

/** One dense row per voicemail: caller, received time and length, the player, and a call-back action. */
export function VoicemailList({ rows, tz, now }: VoicemailListProps) {
  return (
    <ul className="flex flex-col divide-y rounded-xl border bg-card">
      {rows.map((row) => {
        const phone = row.phone ? formatPhoneDisplay(row.phone) : "";
        const subtitle = [row.leadId ? row.contactName : null, phone].filter(Boolean).join(" · ");
        return (
          <li
            key={row.callId}
            className="grid grid-cols-1 gap-3 p-4 md:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)_auto] md:items-center md:gap-6"
          >
            <div className="min-w-0">
              {row.leadId ? (
                <Link
                  href={`/leads/${row.leadId}`}
                  className="block truncate text-base font-bold outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {row.businessName ?? "Lead"}
                </Link>
              ) : (
                <p className="truncate text-base font-bold">Unknown caller</p>
              )}
              {subtitle ? <p className="truncate text-sm text-muted-foreground tabular-nums">{subtitle}</p> : null}
              <p className="mt-0.5 text-xs text-muted-foreground">
                <DateTime value={row.createdAt} tz={tz} now={now} />
                {" · "}
                <span className="tabular-nums">{formatDuration(row.durationSeconds)}</span>
              </p>
            </div>

            {/* Keyed by call only: marking a voicemail heard refreshes the page, and a key that changed with the
                heard flag would remount the <audio> element and stop playback a moment after the owner pressed play. */}
            <VoicemailPlayer
              key={row.callId}
              callId={row.callId}
              unheard={row.unheard}
              canMarkHeard={row.canMarkHeard}
            />

            <div className="flex md:justify-end">
              {row.leadId && row.leadStatus && row.phone ? (
                <CallButton
                  lead={{
                    id: row.leadId,
                    businessName: row.businessName ?? "Lead",
                    contactName: row.contactName,
                    phone: row.phone,
                    status: row.leadStatus,
                  }}
                  label="Call back"
                  className="w-full md:w-auto"
                />
              ) : row.phone ? (
                <a href={telHref(row.phone)} aria-label={`Call back ${phone}`} className={TEL_CLASS}>
                  <Phone aria-hidden />
                  Call back
                </a>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

"use client";

import { useRef, useState, useTransition } from "react";
import { notifyVoicemailsChanged } from "@/lib/dialer/events";
import { markVoicemailHeardAction } from "@/server/actions/leads";

export interface VoicemailPlayerProps {
  callId: string;
  unheard: boolean;
  /** Only the voicemail's owner marks it heard; the server enforces the same rule (D20). */
  canMarkHeard: boolean;
}

/** Streams through /api/voicemail/<callId> (never a Twilio URL) and marks the voicemail heard on the owner's first play. */
export function VoicemailPlayer({ callId, unheard, canMarkHeard }: VoicemailPlayerProps) {
  const [heard, setHeard] = useState(!unheard);
  const requested = useRef(false);
  const [, startTransition] = useTransition();
  const showUnheard = unheard && !heard;

  function onPlay() {
    if (!canMarkHeard || !showUnheard || requested.current) return;
    requested.current = true;
    startTransition(async () => {
      const result = await markVoicemailHeardAction(callId);
      if (result.ok) {
        setHeard(true);
        notifyVoicemailsChanged();
      } else {
        requested.current = false;
      }
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-xs font-semibold">
        <span>Voicemail</span>
        {showUnheard ? (
          <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-bold text-primary-foreground">Unheard</span>
        ) : null}
      </div>
      <audio
        controls
        preload="none"
        src={`/api/voicemail/${encodeURIComponent(callId)}`}
        onPlay={onPlay}
        aria-label="Play voicemail"
        className="h-12 w-full"
      />
    </div>
  );
}

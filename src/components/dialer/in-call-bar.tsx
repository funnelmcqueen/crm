"use client";

import { Grid3x3, Mic, MicOff, PhoneOff, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { BookMeetingButton } from "@/components/booking/book-meeting-button";
import { formatCallTimer, type DialerState } from "@/lib/dialer/state";
import { cn } from "@/lib/utils";
import { Keypad } from "./keypad";
import { useTranslations } from "@/components/i18n/locale-provider";

type LiveCallState = Extract<DialerState, { kind: "preparing" | "ringing" | "in-call" }>;

export interface InCallBarProps {
  state: LiveCallState;
  onHangup(): void;
  onMutedChange(muted: boolean): void;
  onDigits(digits: string): void;
}

function CallTimer({ connectedAt }: { connectedAt: number }) {
  const t = useTranslations("workspace");
  const [now, setNow] = useState(connectedAt);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const interval = setInterval(tick, 1000);
    const first = setTimeout(tick, 0);
    return () => {
      clearInterval(interval);
      clearTimeout(first);
    };
  }, []);
  return (
    <span className="font-extrabold tabular-nums" aria-label={t.callDuration}>
      {formatCallTimer(now - connectedAt)}
    </span>
  );
}

const controlClass =
  "inline-flex min-h-12 min-w-12 items-center justify-center gap-2 rounded-xl px-3 text-sm font-bold outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-primary-foreground/70 disabled:opacity-50 [&_svg]:size-5";

/** Sticky red bar for the live call: above the mobile tab bar, at the bottom of the main area on desktop. */
export function InCallBar({ state, onHangup, onMutedChange, onDigits }: InCallBarProps) {
  const t = useTranslations("workspace");
  const [keypadOpen, setKeypadOpen] = useState(false);
  const connected = state.kind === "in-call";
  const muted = connected && state.muted;
  const warning = state.kind === "preparing" ? null : state.warning;

  return (
    <section
      aria-label={t.activeCall}
      className="fixed inset-x-0 bottom-[var(--bottom-nav-height)] z-40 bg-primary text-primary-foreground shadow-lg md:left-60"
    >
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-2 md:px-8">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-extrabold">{state.subject.label}</p>
          <p className="flex items-center gap-2 text-sm font-semibold text-primary-foreground/85">
            {connected ? (
              <CallTimer key={state.connectedAt} connectedAt={state.connectedAt} />
            ) : (
              <span aria-live="polite">{state.kind === "ringing" ? t.ringing : t.calling}</span>
            )}
            {warning ? (
              <span role="status" className="inline-flex min-w-0 items-center gap-1 truncate font-bold">
                <TriangleAlert aria-hidden className="size-4 shrink-0" />
                <span className="truncate">{warning}</span>
              </span>
            ) : null}
          </p>
        </div>

        {state.subject.leadId ? (
          <BookMeetingButton
            leadId={state.subject.leadId}
            businessName={state.subject.label}
            triggerClassName={cn(controlClass, "bg-black/20 hover:bg-black/30")}
          />
        ) : null}

        <button
          type="button"
          aria-label={muted ? t.unmute : t.mute}
          aria-pressed={muted}
          disabled={!connected}
          onClick={() => onMutedChange(!muted)}
          className={cn(
            controlClass,
            muted ? "bg-primary-foreground text-primary" : "bg-black/20 hover:bg-black/30",
          )}
        >
          {muted ? <MicOff aria-hidden /> : <Mic aria-hidden />}
          <span className="hidden md:inline">{muted ? t.unmute : t.mute}</span>
        </button>

        <button
          type="button"
          aria-label={t.keypad}
          disabled={!connected}
          onClick={() => setKeypadOpen(true)}
          className={cn(controlClass, "bg-black/20 hover:bg-black/30")}
        >
          <Grid3x3 aria-hidden />
          <span className="hidden md:inline">{t.keypad}</span>
        </button>

        <button
          type="button"
          aria-label={t.hangUp}
          onClick={onHangup}
          className={cn(controlClass, "bg-primary-foreground px-4 text-primary hover:bg-primary-foreground/90")}
        >
          <PhoneOff aria-hidden />
          <span className="hidden sm:inline">{t.hangUp}</span>
        </button>
      </div>

      {connected ? <Keypad open={keypadOpen} onOpenChange={setKeypadOpen} onDigit={onDigits} /> : null}
    </section>
  );
}

"use client";

import { Grid3x3, Phone, Delete } from "lucide-react";
import { useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { normalizePhone, formatPhoneDisplay } from "@/lib/domain/phone";
import { telHref, type DialMode } from "@/lib/dialer/resolve-mode";
import type { ManualDialTarget } from "@/lib/dialer/types";
import { useDialer } from "./dialer-context";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

export function manualDialPreview(raw: string): { e164: string; display: string } | null {
  const result = normalizePhone(raw, "US");
  return result.ok ? { e164: result.e164, display: formatPhoneDisplay(result.e164) } : null;
}

export interface ManualCallActions {
  dialMode: DialMode;
  startManualCall(target: ManualDialTarget): Promise<void>;
  beginManualTelCall(target: ManualDialTarget): Promise<boolean>;
}

/** Returns false when validation or TEL call creation refuses the dial. */
export async function placeManualCall(
  raw: string,
  actions: ManualCallActions,
  openTel: (href: string) => void,
): Promise<boolean> {
  const preview = manualDialPreview(raw);
  if (!preview) return false;
  const target = { phone: raw, label: preview.display };
  if (actions.dialMode === "tel") {
    if (!await actions.beginManualTelCall(target)) return false;
    openTel(telHref(preview.e164));
    return true;
  }
  await actions.startManualCall(target);
  return true;
}

export interface ManualKeypadControlsProps {
  value: string;
  busy: boolean;
  error: string;
  onValueChange(value: string): void;
  onCall(): void;
  onClose(): void;
}

/** The idle dial surface also renders alone in tests, outside the Sheet portal. */
export function ManualKeypadControls({ value, busy, error, onValueChange, onCall, onClose }: ManualKeypadControlsProps) {
  const preview = manualDialPreview(value);
  const append = (key: string) => onValueChange((value + key).slice(0, 100));
  return (
    <div
      className="mx-auto w-full max-w-sm"
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || event.altKey || event.ctrlKey || event.metaKey) return;
        if (KEYS.includes(event.key as (typeof KEYS)[number])) {
          event.preventDefault();
          append(event.key);
        } else if (event.key === "Backspace") {
          event.preventDefault();
          onValueChange(value.slice(0, -1));
        }
      }}
    >
      <SheetHeader className="px-4 pt-4 pr-16">
        <SheetTitle className="text-lg font-bold">Keypad</SheetTitle>
        <SheetDescription>Enter a number to call.</SheetDescription>
      </SheetHeader>
      <div className="px-4">
        <label htmlFor="manual-keypad-number" className="sr-only">Phone number</label>
        <input
          id="manual-keypad-number"
          aria-label="Phone number"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={value}
          maxLength={100}
          disabled={busy}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder="Phone number"
          className="min-h-12 w-full rounded-xl border bg-background px-4 text-center text-xl font-bold tabular-nums outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <p aria-live="polite" className="min-h-6 pt-1 text-center text-sm text-muted-foreground">
          {preview ? preview.display : value ? "Enter a valid phone number" : ""}
        </p>
        {error ? <p role="alert" className="text-center text-sm text-destructive">{error}</p> : null}
      </div>
      <div className="grid grid-cols-3 gap-2 px-4 pt-2">
        {KEYS.map((key) => (
          <button
            key={key}
            type="button"
            aria-label={key === "*" ? "Star" : key === "#" ? "Pound" : key}
            disabled={busy}
            onClick={() => append(key)}
            className="min-h-12 rounded-xl border bg-card text-2xl font-extrabold tabular-nums outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            {key}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 px-4 pt-3">
        <button type="button" aria-label="Close keypad" disabled={busy} onClick={onClose} className="min-h-12 rounded-xl border px-2 font-bold outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50">Close</button>
        <button type="button" aria-label="Call number" disabled={!preview || busy} onClick={onCall} className="min-h-12 rounded-xl bg-primary px-2 font-bold text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50">
          <Phone aria-hidden className="mx-auto size-5" />
          Call
        </button>
        <button type="button" aria-label="Backspace" disabled={!value || busy} onClick={() => onValueChange(value.slice(0, -1))} className="min-h-12 rounded-xl border px-2 font-bold outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50">
          <Delete aria-hidden className="mx-auto size-5" />
          <span className="sr-only">Backspace</span>
        </button>
      </div>
    </div>
  );
}

/** One launcher for every signed-in route. Connected-call tones stay in InCallBar. */
export function PersistentKeypad() {
  const dialer = useDialer();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!dialer) return null;
  const idle = dialer.state.kind === "idle";

  const call = async () => {
    if (!idle || busy || !manualDialPreview(value)) return;
    setBusy(true);
    setError("");
    try {
      const started = await placeManualCall(value, dialer, (href) => { window.location.href = href; });
      if (started && dialer.dialMode === "tel") {
        setOpen(false);
        setValue("");
      } else if (!started) {
        setError("The call could not be started. Please try again.");
      }
    } catch {
      setError("The call could not be started. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {idle ? (
        <button
          type="button"
          aria-label="Open keypad"
          onClick={() => setOpen(true)}
          className="fixed right-3 bottom-[calc(var(--bottom-nav-height)+0.75rem)] z-40 inline-flex min-h-12 items-center gap-2 rounded-full bg-primary px-5 font-bold text-primary-foreground shadow-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:right-4 md:bottom-4"
        >
          <Grid3x3 aria-hidden className="size-5" />
          Keypad
        </button>
      ) : null}
      <Sheet open={open && idle} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <SheetContent
          side="bottom"
          className="max-h-[calc(100dvh-0.5rem)] overflow-y-auto rounded-t-2xl pb-[calc(env(safe-area-inset-bottom)+1rem)] md:data-[side=bottom]:left-auto md:data-[side=bottom]:right-4 md:data-[side=bottom]:bottom-4 md:w-96 md:max-h-[calc(100dvh-2rem)] md:rounded-2xl md:pb-4"
        >
          <ManualKeypadControls
            value={value}
            busy={busy}
            error={error}
            onValueChange={(next) => { setValue(next); setError(""); }}
            onCall={() => void call()}
            onClose={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

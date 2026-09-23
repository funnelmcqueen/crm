"use client";

import { Phone } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import { manualDialPreview, placeManualCall } from "@/components/dialer/persistent-keypad";
import { useDialer } from "@/components/dialer/dialer-context";

export interface ManualCallbackButtonProps {
  phone: string;
}

/** Calls an unmatched number through the same server-created manual-call flow as the persistent keypad. */
export function ManualCallbackButton({ phone }: ManualCallbackButtonProps) {
  const dialer = useDialer();
  const [busy, setBusy] = useState(false);
  const preview = manualDialPreview(phone);
  if (!preview) return null;
  const label = `Call back ${formatPhoneDisplay(preview.e164)}`;
  const disabled = !dialer || busy || dialer.state.kind !== "idle";

  async function call() {
    if (!dialer || disabled) return;
    setBusy(true);
    try {
      const started = await placeManualCall(phone, dialer, (href) => { window.location.href = href; });
      if (!started) toast.error("The call could not be started. Please try again.");
    } catch {
      toast.error("The call could not be started. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={() => void call()}
      className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-base font-extrabold tracking-wide text-primary-foreground uppercase outline-none transition-colors duration-150 select-none hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50"
    >
      <Phone aria-hidden className="size-5" />
      {busy ? "Calling..." : "Call back"}
    </button>
  );
}
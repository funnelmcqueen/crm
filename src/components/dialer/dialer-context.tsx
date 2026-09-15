"use client";

import { createContext, useContext } from "react";
import type { DialMode } from "@/lib/dialer/resolve-mode";
import type { DialerState } from "@/lib/dialer/state";
import type { DialableLead } from "@/lib/dialer/types";

export interface DialerContextValue {
  state: DialerState;
  timezone: string;
  /** How a CALL tapped right now would be placed. */
  dialMode: DialMode;
  /** The in-app device is still registering and the call would be in-app once it is ready. */
  connecting: boolean;
  /** In-app call. Ignored unless idle and the lead is dialable. */
  startCall(lead: DialableLead): void;
  /** Records a tapped tel: link. Returns false when the tap must be cancelled (not idle, or not dialable). */
  beginTelCall(lead: DialableLead): boolean;
  hangup(): void;
  setMuted(muted: boolean): void;
  sendDigits(digits: string): void;
}

export const DialerContext = createContext<DialerContextValue | null>(null);

/** Null outside the (app) layout's DialerProvider. */
export function useDialer(): DialerContextValue | null {
  return useContext(DialerContext);
}

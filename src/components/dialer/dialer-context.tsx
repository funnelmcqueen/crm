"use client";

import { createContext, useContext } from "react";
import type { DialMode } from "@/lib/dialer/resolve-mode";
import type { DialerState } from "@/lib/dialer/state";
import type { DialableLead, ManualDialTarget } from "@/lib/dialer/types";

export interface DialerContextValue {
  state: DialerState;
  timezone: string;
  /** How a CALL tapped right now would be placed. */
  dialMode: DialMode;
  /** The in-app device is still registering and the call would be in-app once it is ready. */
  connecting: boolean;
  /** In-app call. Ignored unless idle and the lead is dialable. */
  startCall(lead: DialableLead): void;
  /** Starts a server-created call to a number entered in the keypad. */
  startManualCall(target: ManualDialTarget): Promise<void>;
  /** Records a tapped tel: link. Returns false when the tap must be cancelled (not idle, or not dialable). */
  beginTelCall(lead: DialableLead): boolean;
  /** Creates the manual call row before the caller opens the phone app. */
  beginManualTelCall(target: ManualDialTarget): Promise<boolean>;
  hangup(): void;
  setMuted(muted: boolean): void;
  sendDigits(digits: string): void;
  /** The in-app device is registered, so it can place and receive calls. */
  deviceReady: boolean;
  /**
   * Audio device selection through the loaded in-app driver. Each resolves false when there is no loaded driver
   * or it does not support the operation (e.g. the mock driver), and rejects when the driver refuses the device.
   */
  setInputDevice(deviceId: string): Promise<boolean>;
  setOutputDevice(deviceId: string): Promise<boolean>;
  testSpeaker(): Promise<boolean>;
}

/** Per-device audio choices (Settings). The provider re-applies them whenever the in-app device becomes ready. */
export const AUDIO_INPUT_STORAGE_KEY = "fmq.audioInput";
export const AUDIO_OUTPUT_STORAGE_KEY = "fmq.audioOutput";

export const DialerContext = createContext<DialerContextValue | null>(null);

/** Null outside the (app) layout's DialerProvider. */
export function useDialer(): DialerContextValue | null {
  return useContext(DialerContext);
}

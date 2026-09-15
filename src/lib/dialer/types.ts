import type { LeadStatus } from "@/lib/domain/statuses";

export type DialerDriverName = "twilio" | "tel" | "mock";

/** Stored per device in localStorage under `fmq.callMode`. */
export type CallModePreference = "auto" | "in-app" | "phone";

export type CallEndReason = "completed" | "busy" | "no-answer" | "failed" | "canceled";

export interface CallEvents {
  onRinging(): void;
  onConnected(): void;
  onDisconnected(reason: CallEndReason): void;
  /** Plain language, e.g. "Poor connection", "Microphone not found". */
  onWarning(message: string): void;
  onError(message: string): void;
}

export interface ActiveCall {
  hangup(): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  sendDigits(digits: string): void;
}

export interface IncomingCall {
  /** From the TwiML `<Parameter name="callId">`; null if Twilio did not pass one. */
  callId: string | null;
  accept(events: CallEvents): ActiveCall;
  reject(): void;
}

export type RegisterResult = { ok: true } | { ok: false; reason: string };

export interface InAppDriver {
  readonly name: "twilio" | "mock";
  register(): Promise<RegisterResult>;
  /** Sends ONLY the server-created call id to the provider. */
  connect(callId: string, events: CallEvents): Promise<ActiveCall>;
  onIncoming(cb: (call: IncomingCall) => void): () => void;
  setInputDevice?(deviceId: string): Promise<void>;
  setOutputDevice?(deviceId: string): Promise<void>;
  testSpeaker?(): Promise<void>;
  destroy(): void;
}

/** What a CALL control needs. Always a lead the signed-in user can already see through RLS. */
export interface DialableLead {
  id: string;
  businessName: string;
  contactName: string | null;
  phone: string;
  status: LeadStatus;
}

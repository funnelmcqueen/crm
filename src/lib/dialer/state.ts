import { preselectOutcomeForEndReason, type CallOutcome } from "@/lib/domain/outcomes";
import type { LeadStatus } from "@/lib/domain/statuses";
import type { CallEndReason } from "./types";

export type CallMode = "IN_APP" | "TEL";

export const UNKNOWN_CALLER_LABEL = "Unknown caller";

export interface CallSubject {
  leadId: string | null;
  /** Business name of the caller's own lead, or "Unknown caller". */
  label: string;
}

export interface IncomingLeadContext {
  leadId: string;
  businessName: string;
  contactName: string | null;
  status: LeadStatus;
}

export type IncomingContext =
  | { status: "loading" }
  | { status: "lead"; lead: IncomingLeadContext }
  | { status: "unknown" };

export interface WrapUp {
  leadId: string | null;
  callId: string | null;
  clientRequestId: string | null;
  mode: CallMode;
  endReason: CallEndReason;
  preselectedOutcome: CallOutcome | null;
  label: string;
}

export type DialerState =
  | { kind: "idle" }
  | { kind: "preparing"; subject: CallSubject; callId: string | null }
  | { kind: "ringing"; subject: CallSubject; callId: string; warning: string | null }
  | {
      kind: "in-call";
      subject: CallSubject;
      callId: string | null;
      direction: "OUTBOUND" | "INBOUND";
      connectedAt: number;
      muted: boolean;
      warning: string | null;
    }
  | ({ kind: "wrap-up" } & WrapUp)
  | { kind: "incoming"; callId: string | null; context: IncomingContext }
  | { kind: "tel-pending"; subject: CallSubject; callId: string | null; clientRequestId: string; startedAt: number };

export type DialerAction =
  | { type: "OUTBOUND_START"; subject: CallSubject }
  | { type: "OUTBOUND_CREATED"; callId: string }
  /** Microphone denied, the outbound route refused, or the driver could not start the call. */
  | { type: "OUTBOUND_ABORTED" }
  | { type: "RINGING" }
  | { type: "CONNECTED"; at: number }
  | { type: "DISCONNECTED"; reason: CallEndReason }
  /** An empty message clears the warning. */
  | { type: "WARNING"; message: string }
  | { type: "MUTED"; muted: boolean }
  | { type: "TEL_START"; leadId: string | null; callId?: string | null; label: string; clientRequestId: string; startedAt: number }
  | { type: "TEL_RETURNED" }
  | { type: "TEL_CANCELED" }
  | { type: "INCOMING"; callId: string | null }
  | { type: "INCOMING_CONTEXT"; callId: string | null; context: IncomingContext }
  | { type: "INCOMING_ACCEPTED"; at: number }
  /** Declined, canceled by the caller, or timed out before it was answered. */
  | { type: "INCOMING_ENDED" }
  | { type: "PRESELECT_OUTCOME"; outcome: CallOutcome }
  | { type: "RESTORE_WRAP_UP"; wrapUp: WrapUp }
  | { type: "WRAP_UP_DONE" };

export const INITIAL_DIALER_STATE: DialerState = { kind: "idle" };

function subjectFromContext(context: IncomingContext): CallSubject {
  if (context.status === "lead") return { leadId: context.lead.leadId, label: context.lead.businessName };
  return { leadId: null, label: UNKNOWN_CALLER_LABEL };
}

function wrapUpFrom(
  subject: CallSubject,
  callId: string | null,
  reason: CallEndReason,
  connected: boolean,
): DialerState {
  return {
    kind: "wrap-up",
    leadId: subject.leadId,
    callId,
    clientRequestId: null,
    mode: "IN_APP",
    endReason: reason,
    // A call that never connected is logged as No Answer by default, whatever the end reason.
    preselectedOutcome: preselectOutcomeForEndReason(reason) ?? (connected ? null : "NO_ANSWER"),
    label: subject.label,
  };
}

/**
 * The single dialer state machine: idle -> preparing -> ringing -> in-call -> wrap-up -> idle, plus
 * incoming and tel-pending. Starting anything (outbound, tel, incoming, restore) is only possible from
 * idle, which is what enforces one active call. Actions that do not apply return the same object.
 */
export function dialerReducer(state: DialerState, action: DialerAction): DialerState {
  switch (action.type) {
    case "OUTBOUND_START":
      return state.kind === "idle" ? { kind: "preparing", subject: action.subject, callId: null } : state;

    case "OUTBOUND_CREATED":
      return state.kind === "preparing" && state.callId === null ? { ...state, callId: action.callId } : state;

    case "OUTBOUND_ABORTED":
      return state.kind === "preparing" ? INITIAL_DIALER_STATE : state;

    case "RINGING":
      if (state.kind === "preparing" && state.callId !== null) {
        return { kind: "ringing", subject: state.subject, callId: state.callId, warning: null };
      }
      return state;

    case "CONNECTED":
      if ((state.kind === "preparing" && state.callId !== null) || state.kind === "ringing") {
        return {
          kind: "in-call",
          subject: state.subject,
          callId: state.callId,
          direction: "OUTBOUND",
          connectedAt: action.at,
          muted: false,
          warning: state.kind === "ringing" ? state.warning : null,
        };
      }
      return state;

    case "DISCONNECTED":
      if (state.kind === "preparing" && state.callId !== null) {
        return wrapUpFrom(state.subject, state.callId, action.reason, false);
      }
      if (state.kind === "ringing") return wrapUpFrom(state.subject, state.callId, action.reason, false);
      if (state.kind === "in-call") return wrapUpFrom(state.subject, state.callId, action.reason, true);
      return state;

    case "WARNING": {
      if (state.kind !== "ringing" && state.kind !== "in-call") return state;
      const warning = action.message.trim() === "" ? null : action.message;
      return warning === state.warning ? state : { ...state, warning };
    }

    case "MUTED":
      return state.kind === "in-call" && state.muted !== action.muted ? { ...state, muted: action.muted } : state;

    case "TEL_START":
      if (state.kind !== "idle") return state;
      return {
        kind: "tel-pending",
        subject: { leadId: action.leadId, label: action.label },
        callId: action.callId ?? null,
        clientRequestId: action.clientRequestId,
        startedAt: action.startedAt,
      };

    case "TEL_RETURNED":
      if (state.kind !== "tel-pending") return state;
      return {
        kind: "wrap-up",
        leadId: state.subject.leadId,
        callId: state.callId,
        clientRequestId: state.clientRequestId,
        mode: "TEL",
        endReason: "completed",
        preselectedOutcome: null,
        label: state.subject.label,
      };

    case "TEL_CANCELED":
      return state.kind === "tel-pending" ? INITIAL_DIALER_STATE : state;

    case "INCOMING":
      return state.kind === "idle" ? { kind: "incoming", callId: action.callId, context: { status: "loading" } } : state;

    case "INCOMING_CONTEXT":
      if (state.kind === "incoming" && state.callId === action.callId) return { ...state, context: action.context };
      if (state.kind === "in-call" && state.direction === "INBOUND" && state.callId === action.callId) {
        return { ...state, subject: subjectFromContext(action.context) };
      }
      return state;

    case "INCOMING_ACCEPTED":
      if (state.kind !== "incoming") return state;
      return {
        kind: "in-call",
        subject:
          state.context.status === "loading" ? { leadId: null, label: "Incoming call" } : subjectFromContext(state.context),
        callId: state.callId,
        direction: "INBOUND",
        connectedAt: action.at,
        muted: false,
        warning: null,
      };

    case "INCOMING_ENDED":
      return state.kind === "incoming" ? INITIAL_DIALER_STATE : state;

    case "PRESELECT_OUTCOME":
      return state.kind === "wrap-up" && state.preselectedOutcome !== action.outcome
        ? { ...state, preselectedOutcome: action.outcome }
        : state;

    case "RESTORE_WRAP_UP":
      return state.kind === "idle" ? { kind: "wrap-up", ...action.wrapUp } : state;

    case "WRAP_UP_DONE":
      return state.kind === "wrap-up" ? INITIAL_DIALER_STATE : state;
  }
}

export function isDialerIdle(state: DialerState): boolean {
  return state.kind === "idle";
}

/** The lead the current call (or pending log) is about, if any. */
export function activeLeadId(state: DialerState): string | null {
  switch (state.kind) {
    case "preparing":
    case "ringing":
    case "in-call":
    case "tel-pending":
      return state.subject.leadId;
    case "wrap-up":
      return state.leadId;
    default:
      return null;
  }
}

/** `m:ss`, or `h:mm:ss` from one hour. Negative input counts as zero. */
export function formatCallTimer(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

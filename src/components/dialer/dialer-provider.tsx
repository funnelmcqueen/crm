"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";
import { startDeviceSession, type DeviceSession, type DeviceStatus } from "@/lib/dialer/device-session";
import { loadInAppDriver } from "@/lib/dialer/drivers/load";
import {
  clearPendingTel,
  newClientRequestId,
  pendingTelWrapUp,
  readPendingTel,
  shouldOpenTelOutcome,
  writePendingTel,
} from "@/lib/dialer/drivers/tel";
import { notifyVoicemailsChanged } from "@/lib/dialer/events";
import { DIALER_MESSAGES, microphoneErrorMessage, outboundErrorMessage } from "@/lib/dialer/messages";
import { isUnansweredCallStatus } from "@/lib/dialer/outcome-form";
import { useCallModePreference } from "@/lib/dialer/preference";
import { currentDeviceIsIOS, resolveDialMode } from "@/lib/dialer/resolve-mode";
import { nextLeadHref, parseSkipParam } from "@/lib/dialer/skip-list";
import {
  INITIAL_DIALER_STATE,
  dialerReducer,
  type DialerAction,
  type DialerState,
  type IncomingContext,
} from "@/lib/dialer/state";
import type {
  ActiveCall,
  CallEndReason,
  CallEvents,
  DialableLead,
  DialerDriverName,
  InAppDriver,
  IncomingCall,
} from "@/lib/dialer/types";
import { preselectOutcomeForEndReason } from "@/lib/domain/outcomes";
import { isDialable } from "@/lib/domain/statuses";
import { getCallStatusAction, getIncomingCallContextAction } from "@/server/actions/calls";
import { DialerContext, type DialerContextValue } from "./dialer-context";
import { InCallBar } from "./in-call-bar";
import { IncomingCallDialog } from "./incoming-call-dialog";
import { OutcomeSheet } from "./outcome-sheet";
import { TelPendingBar } from "./tel-pending-bar";

export interface DialerProviderProps {
  userId: string;
  defaultDriver: DialerDriverName;
  inAppEnabled: boolean;
  timezone: string;
  children: ReactNode;
}

const REGISTER_TIMEOUT_MS = 15_000;
/** A failed or lost device tries again this often (each try fetches a voice token: 20 per 10 min). */
const REGISTER_RETRY_MS = 60_000;
const PRESENCE_INTERVAL_MS = 60_000;
/** Twilio dials the agent for 20s; the incoming UI never outlives that by much. */
const INCOMING_TIMEOUT_MS = 30_000;
const STATUS_RECHECK_ATTEMPTS = 4;
const STATUS_RECHECK_INTERVAL_MS = 1_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const noopSubscribe = () => () => {};
const serverIsIOS = () => false;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchVoiceToken(): Promise<{ token: string; ttl: number }> {
  const response = await fetch("/api/voice/token", { method: "POST", credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`voice token request failed (${response.status})`);
  const body: unknown = await response.json();
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof record.token !== "string" || record.token === "") throw new Error("voice token missing");
  return { token: record.token, ttl: typeof record.ttl === "number" ? record.ttl : 3600 };
}

/** Asks for the microphone once. Returns an error message, or null when access was granted. */
async function requestMicrophone(): Promise<string | null> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return DIALER_MESSAGES.micBlocked;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return null;
  } catch (error) {
    return microphoneErrorMessage(error);
  }
}

function currentSkipList(): string[] {
  return parseSkipParam(new URLSearchParams(window.location.search).get("skip"));
}

export function DialerProvider({ userId, defaultDriver, inAppEnabled, timezone, children }: DialerProviderProps) {
  const router = useRouter();
  const [state, setState] = useState<DialerState>(INITIAL_DIALER_STATE);
  // Mirrors `state` synchronously so a double tap can never start two calls.
  const stateRef = useRef<DialerState>(INITIAL_DIALER_STATE);
  const dispatch = useCallback((action: DialerAction) => {
    const next = dialerReducer(stateRef.current, action);
    if (next !== stateRef.current) {
      stateRef.current = next;
      setState(next);
    }
  }, []);

  const [preference] = useCallModePreference();
  const isIOS = useSyncExternalStore(noopSubscribe, currentDeviceIsIOS, serverIsIOS);
  const shouldRegister = defaultDriver !== "tel" && inAppEnabled;
  const [device, setDevice] = useState<DeviceStatus>(shouldRegister ? "registering" : "off");

  const sessionRef = useRef<DeviceSession | null>(null);
  const activeCallRef = useRef<ActiveCall | null>(null);
  const incomingRef = useRef<IncomingCall | null>(null);
  const callTokenRef = useRef(0);
  const cancelTokenRef = useRef(-1);
  const micGrantedRef = useRef(false);

  const ensureMicrophone = useCallback(async (driver: InAppDriver): Promise<string | null> => {
    // The mock driver plays no audio, so it never prompts (keeps automated browsers prompt-free).
    if (driver.name !== "twilio" || micGrantedRef.current) return null;
    const error = await requestMicrophone();
    if (error === null) micGrantedRef.current = true;
    return error;
  }, []);

  // Restore a phone call that was tapped before a reload.
  useEffect(() => {
    const now = Date.now();
    const pending = readPendingTel(now, userId);
    if (!pending) {
      clearPendingTel();
      return;
    }
    if (pending.stage === "wrap-up" || shouldOpenTelOutcome(pending, now)) {
      writePendingTel({ ...pending, stage: "wrap-up" });
      dispatch({ type: "RESTORE_WRAP_UP", wrapUp: pendingTelWrapUp(pending) });
    } else {
      dispatch({
        type: "TEL_START",
        leadId: pending.leadId,
        label: pending.label,
        clientRequestId: pending.clientRequestId,
        startedAt: pending.startedAt,
      });
    }
  }, [dispatch, userId]);

  const handleIncoming = useCallback(
    (call: IncomingCall) => {
      if (stateRef.current.kind !== "idle") {
        call.reject();
        return;
      }
      incomingRef.current = call;
      dispatch({ type: "INCOMING", callId: call.callId });
      call.onCancel?.(() => {
        if (incomingRef.current !== call) return;
        incomingRef.current = null;
        dispatch({ type: "INCOMING_ENDED" });
      });
      if (incomingRef.current !== call) return;

      const callId = call.callId;
      const setContext = (context: IncomingContext) => dispatch({ type: "INCOMING_CONTEXT", callId, context });
      if (callId === null || !UUID.test(callId)) {
        setContext({ status: "unknown" });
        return;
      }
      getIncomingCallContextAction(callId)
        .then((result) =>
          setContext(result.ok && result.data.lead ? { status: "lead", lead: result.data.lead } : { status: "unknown" }),
        )
        .catch(() => setContext({ status: "unknown" }));
    },
    [dispatch],
  );

  // One in-app device for the whole signed-in session, so callbacks ring on any page.
  useEffect(() => {
    if (!shouldRegister) return;
    const driverName = defaultDriver === "twilio" ? "twilio" : "mock";
    const session = startDeviceSession({
      load: () => loadInAppDriver(driverName, { fetchToken: fetchVoiceToken, exposeTestHooks: driverName === "mock" }),
      onIncoming: handleIncoming,
      onStatus: (status, notify) => {
        setDevice(status);
        if (notify) toast(DIALER_MESSAGES.inAppUnavailable, { id: "dialer-device" });
      },
      registerTimeoutMs: REGISTER_TIMEOUT_MS,
      retryMs: REGISTER_RETRY_MS,
    });
    sessionRef.current = session;
    return () => {
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [shouldRegister, defaultDriver, handleIncoming]);

  // Twilio routes callbacks only to agents whose device checked in recently, so only a working device pings.
  useEffect(() => {
    if (device !== "ready" || !shouldRegister || defaultDriver !== "twilio") return;
    const ping = () => {
      void fetch("/api/voice/presence", { method: "POST", credentials: "same-origin", cache: "no-store" }).catch(
        () => undefined,
      );
    };
    ping();
    const interval = setInterval(ping, PRESENCE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [device, shouldRegister, defaultDriver]);

  const deviceReady = device === "ready";
  const dialMode = resolveDialMode({ preference, defaultDriver, isIOS, inAppEnabled, deviceReady });
  const connecting =
    device === "registering" &&
    resolveDialMode({ preference, defaultDriver, isIOS, inAppEnabled, deviceReady: true }) === "in-app";

  const recheckServerStatus = useCallback(
    async (callId: string) => {
      for (let attempt = 0; attempt < STATUS_RECHECK_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await sleep(STATUS_RECHECK_INTERVAL_MS);
        const current = stateRef.current;
        if (current.kind !== "wrap-up" || current.callId !== callId || current.preselectedOutcome !== null) return;
        try {
          const result = await getCallStatusAction(callId);
          if (result.ok && isUnansweredCallStatus(result.data.callStatus)) {
            dispatch({ type: "PRESELECT_OUTCOME", outcome: "NO_ANSWER" });
            return;
          }
        } catch {
          // Offline: keep the driver's end reason.
        }
      }
    },
    [dispatch],
  );

  const startCall = useCallback(
    async (lead: DialableLead) => {
      const driver = sessionRef.current?.readyDriver() ?? null;
      if (!driver || stateRef.current.kind !== "idle" || !isDialable(lead.status)) return;

      const token = callTokenRef.current + 1;
      callTokenRef.current = token;
      dispatch({ type: "OUTBOUND_START", subject: { leadId: lead.id, label: lead.businessName } });
      const isCurrent = () => callTokenRef.current === token;
      const abort = (message: string | null) => {
        if (!isCurrent()) return;
        dispatch({ type: "OUTBOUND_ABORTED" });
        if (message) toast.error(message);
      };

      const micError = await ensureMicrophone(driver);
      if (micError) return abort(micError);
      if (cancelTokenRef.current === token) return abort(null);

      let callId: string;
      try {
        const response = await fetch("/api/calls/outbound", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId: lead.id }),
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          // The toast says calls will use the phone, so make that true: stop offering in-app CALL.
          if (response.status === 403) {
            sessionRef.current?.turnOff();
            router.refresh();
          } else if (response.status === 503) {
            sessionRef.current?.markUnavailable();
          }
          return abort(outboundErrorMessage(response.status, body));
        }
        const id = typeof body === "object" && body !== null ? (body as { callId?: unknown }).callId : undefined;
        if (typeof id !== "string" || !UUID.test(id)) return abort(DIALER_MESSAGES.startFailed);
        callId = id;
      } catch {
        return abort(DIALER_MESSAGES.startFailed);
      }
      if (cancelTokenRef.current === token) return abort(null);
      if (!isCurrent()) return;

      dispatch({ type: "OUTBOUND_CREATED", callId });
      let ended = false;
      const events: CallEvents = {
        onRinging: () => {
          if (isCurrent()) dispatch({ type: "RINGING" });
        },
        onConnected: () => {
          if (isCurrent()) dispatch({ type: "CONNECTED", at: Date.now() });
        },
        onDisconnected: (reason) => {
          if (ended || !isCurrent()) return;
          ended = true;
          activeCallRef.current = null;
          dispatch({ type: "DISCONNECTED", reason });
          // Twilio reports busy/no-answer on the child leg; the server row knows better than the device.
          if (preselectOutcomeForEndReason(reason) === null) void recheckServerStatus(callId);
        },
        onWarning: (message) => {
          if (isCurrent()) dispatch({ type: "WARNING", message });
        },
        onError: (message) => {
          if (isCurrent() && message) toast.error(message);
        },
      };

      try {
        const call = await driver.connect(callId, events);
        if (ended || !isCurrent()) return;
        activeCallRef.current = call;
        if (cancelTokenRef.current === token) call.hangup();
      } catch {
        if (ended) return;
        ended = true;
        activeCallRef.current = null;
        abort(DIALER_MESSAGES.startFailed);
      }
    },
    [dispatch, ensureMicrophone, recheckServerStatus, router],
  );

  const beginTelCall = useCallback(
    (lead: DialableLead): boolean => {
      if (stateRef.current.kind !== "idle" || !isDialable(lead.status)) return false;
      const pending = {
        userId,
        leadId: lead.id,
        label: lead.businessName,
        clientRequestId: newClientRequestId(),
        startedAt: Date.now(),
        stage: "calling" as const,
      };
      writePendingTel(pending);
      dispatch({
        type: "TEL_START",
        leadId: pending.leadId,
        label: pending.label,
        clientRequestId: pending.clientRequestId,
        startedAt: pending.startedAt,
      });
      return true;
    },
    [dispatch, userId],
  );

  const openTelOutcome = useCallback(() => {
    const current = stateRef.current;
    if (current.kind !== "tel-pending") return;
    writePendingTel({
      userId,
      leadId: current.subject.leadId,
      label: current.subject.label,
      clientRequestId: current.clientRequestId,
      startedAt: current.startedAt,
      stage: "wrap-up",
    });
    dispatch({ type: "TEL_RETURNED" });
  }, [dispatch, userId]);

  const cancelTelCall = useCallback(() => {
    clearPendingTel();
    dispatch({ type: "TEL_CANCELED" });
  }, [dispatch]);

  // Back from the phone app: open the outcome sheet.
  const telStartedAt = state.kind === "tel-pending" ? state.startedAt : null;
  useEffect(() => {
    if (telStartedAt === null) return;
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      if (shouldOpenTelOutcome({ startedAt: telStartedAt }, Date.now())) openTelOutcome();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    window.addEventListener("pageshow", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("pageshow", onReturn);
    };
  }, [telStartedAt, openTelOutcome]);

  const hangup = useCallback(() => {
    const call = activeCallRef.current;
    if (call) {
      call.hangup();
      return;
    }
    if (stateRef.current.kind === "preparing" || stateRef.current.kind === "ringing") {
      cancelTokenRef.current = callTokenRef.current;
    }
  }, []);

  const setMuted = useCallback(
    (muted: boolean) => {
      const call = activeCallRef.current;
      if (!call) return;
      call.setMuted(muted);
      dispatch({ type: "MUTED", muted: call.isMuted() });
    },
    [dispatch],
  );

  const sendDigits = useCallback((digits: string) => {
    activeCallRef.current?.sendDigits(digits);
  }, []);

  const endIncoming = useCallback(() => {
    incomingRef.current = null;
    dispatch({ type: "INCOMING_ENDED" });
  }, [dispatch]);

  const declineIncoming = useCallback(() => {
    const call = incomingRef.current;
    try {
      call?.reject();
    } finally {
      endIncoming();
    }
  }, [endIncoming]);

  const acceptIncoming = useCallback(async () => {
    const call = incomingRef.current;
    // A call can ring on a device that registered after the 15s fallback, so any loaded driver may answer.
    const driver = sessionRef.current?.loadedDriver() ?? null;
    if (!call || !driver || stateRef.current.kind !== "incoming") return;

    const micError = await ensureMicrophone(driver);
    // The caller may have hung up while the microphone prompt was open (onCancel cleared the ref).
    if (incomingRef.current !== call) return;
    if (micError) {
      declineIncoming();
      toast.error(micError);
      return;
    }

    const token = callTokenRef.current + 1;
    callTokenRef.current = token;
    let accepted = false;
    let endedBeforeAccept: CallEndReason | null = null;
    const events: CallEvents = {
      onRinging: () => {},
      onConnected: () => {},
      onDisconnected: (reason) => {
        if (callTokenRef.current !== token) return;
        if (!accepted) {
          endedBeforeAccept = reason;
          return;
        }
        activeCallRef.current = null;
        dispatch({ type: "DISCONNECTED", reason });
      },
      onWarning: (message) => {
        if (callTokenRef.current === token) dispatch({ type: "WARNING", message });
      },
      onError: (message) => {
        if (callTokenRef.current === token && message) toast.error(message);
      },
    };

    let active: ActiveCall;
    try {
      // Throws when the call already ended (caller hung up, or another tab answered).
      active = call.accept(events);
    } catch {
      endIncoming();
      toast.error(DIALER_MESSAGES.acceptFailed);
      return;
    }
    incomingRef.current = null;
    accepted = true;
    dispatch({ type: "INCOMING_ACCEPTED", at: Date.now() });
    if (endedBeforeAccept !== null) {
      dispatch({ type: "DISCONNECTED", reason: endedBeforeAccept });
      return;
    }
    activeCallRef.current = active;
  }, [declineIncoming, dispatch, endIncoming, ensureMicrophone]);

  const incomingCallId = state.kind === "incoming" ? state.callId : undefined;
  useEffect(() => {
    if (incomingCallId === undefined) return;
    const timeout = setTimeout(declineIncoming, INCOMING_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [incomingCallId, declineIncoming]);

  const finishWrapUp = useCallback(() => {
    const current = stateRef.current;
    if (current.kind !== "wrap-up") return;
    if (current.mode === "TEL") clearPendingTel();
    dispatch({ type: "WRAP_UP_DONE" });
  }, [dispatch]);

  const handleSaved = useCallback(
    (goNext: boolean) => {
      finishWrapUp();
      notifyVoicemailsChanged();
      if (goNext) router.push(nextLeadHref(currentSkipList()));
      else router.refresh();
    },
    [finishWrapUp, router],
  );

  const value = useMemo<DialerContextValue>(
    () => ({
      state,
      timezone,
      dialMode,
      connecting,
      startCall: (lead) => void startCall(lead),
      beginTelCall,
      hangup,
      setMuted,
      sendDigits,
    }),
    [state, timezone, dialMode, connecting, startCall, beginTelCall, hangup, setMuted, sendDigits],
  );

  return (
    <DialerContext.Provider value={value}>
      {children}
      {state.kind === "preparing" || state.kind === "ringing" || state.kind === "in-call" || state.kind === "tel-pending" ? (
        // The fixed call bars would otherwise cover the end of the page.
        <div aria-hidden className="h-20" />
      ) : null}
      {state.kind === "preparing" || state.kind === "ringing" || state.kind === "in-call" ? (
        <InCallBar state={state} onHangup={hangup} onMutedChange={setMuted} onDigits={sendDigits} />
      ) : null}
      {state.kind === "tel-pending" ? (
        <TelPendingBar label={state.subject.label} onLogOutcome={openTelOutcome} onDismiss={cancelTelCall} />
      ) : null}
      {state.kind === "incoming" ? (
        <IncomingCallDialog context={state.context} onAccept={() => void acceptIncoming()} onDecline={declineIncoming} />
      ) : null}
      {state.kind === "wrap-up" ? (
        <OutcomeSheet
          key={state.callId ?? state.clientRequestId ?? "wrap-up"}
          wrapUp={state}
          timezone={timezone}
          onSaved={handleSaved}
          onDiscard={finishWrapUp}
        />
      ) : null}
    </DialerContext.Provider>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/components/i18n/locale-provider";
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
import { canStartManualDial, requestManualCallId, type ManualCallRequest } from "@/lib/dialer/manual-dial";
import { isUnansweredCallStatus } from "@/lib/dialer/outcome-form";
import { recoverWrapUp, wrapUpForRecovery } from "@/lib/dialer/recover-wrap-up";
import { draftKey, readDraft, removeDraft, wrapUpDraftSchema, writeDraft } from "@/lib/dialer/workspace-drafts";
import { useCallModePreference } from "@/lib/dialer/preference";
import { currentDeviceIsIOS, resolveDialMode } from "@/lib/dialer/resolve-mode";
import { nextLeadHref, parseSkipParam } from "@/lib/dialer/skip-list";
import {
  INITIAL_DIALER_STATE,
  dialerReducer,
  type DialerAction,
  type DialerState,
  type IncomingContext,
  type CallSubject,
} from "@/lib/dialer/state";
import type {
  ActiveCall,
  CallEndReason,
  CallEvents,
  DialableLead,
  DialerDriverName,
  InAppDriver,
  IncomingCall,
  ManualDialTarget,
} from "@/lib/dialer/types";
import { preselectOutcomeForEndReason } from "@/lib/domain/outcomes";
import { isDialable } from "@/lib/domain/statuses";
import { E164_PATTERN } from "@/lib/domain/phone";
import { getCallStatusAction, getIncomingCallContextAction } from "@/server/actions/calls";
import {
  AUDIO_INPUT_STORAGE_KEY,
  AUDIO_OUTPUT_STORAGE_KEY,
  DialerContext,
  type DialerContextValue,
} from "./dialer-context";
import { InCallBar } from "./in-call-bar";
import { IncomingCallDialog } from "./incoming-call-dialog";
import { OutcomeSheet } from "./outcome-sheet";
import { PersistentKeypad } from "./persistent-keypad";
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

async function requestLeadCallId(leadId: string, messages: { [K in keyof typeof DIALER_MESSAGES]: string }): Promise<ManualCallRequest> {
  try {
    const response = await fetch("/api/calls/outbound", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadId }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, status: response.status, message: outboundErrorMessage(response.status, body, messages) };
    const id = typeof body === "object" && body !== null ? (body as { callId?: unknown }).callId : undefined;
    return typeof id === "string" && UUID.test(id)
      ? { ok: true, callId: id }
      : { ok: false, message: messages.startFailed };
  } catch {
    return { ok: false, message: messages.startFailed };
  }
}

/** Asks for the microphone once. Returns an error message, or null when access was granted. */
async function requestMicrophone(messages: { [K in keyof typeof DIALER_MESSAGES]: string }): Promise<string | null> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return messages.micBlocked;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return null;
  } catch (error) {
    return microphoneErrorMessage(error, messages);
  }
}

function currentSkipList(): string[] {
  return parseSkipParam(new URLSearchParams(window.location.search).get("skip"));
}

export function DialerProvider({ userId, defaultDriver, inAppEnabled, timezone, children }: DialerProviderProps) {
  const t = useTranslations("workspace");
  const recoveryKey = draftKey(userId, "wrapup", "current");
  const recoveringRef = useRef(true);
  const [recovering, setRecovering] = useState(true);
  const [recoveryError, setRecoveryError] = useState(false);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const router = useRouter();
  const [state, setState] = useState<DialerState>(INITIAL_DIALER_STATE);
  // Mirrors `state` synchronously so a double tap can never start two calls.
  const stateRef = useRef<DialerState>(INITIAL_DIALER_STATE);
  const dispatch = useCallback((action: DialerAction) => {
    const next = dialerReducer(stateRef.current, action);
    if (next !== stateRef.current) {
      const recovery = wrapUpForRecovery(next);
      if (recovery) writeDraft(recoveryKey, recovery);
      stateRef.current = next;
      setState(next);
    }
  }, [recoveryKey]);

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
  const manualTelStartingRef = useRef(false);

  const ensureMicrophone = useCallback(async (driver: InAppDriver): Promise<string | null> => {
    // The mock driver plays no audio, so it never prompts (keeps automated browsers prompt-free).
    if (driver.name !== "twilio" || micGrantedRef.current) return null;
    const error = await requestMicrophone(t.dialerErrors);
    if (error === null) micGrantedRef.current = true;
    return error;
  }, [t.dialerErrors]);

  // Recover a call after reload without starting another call or trusting cached access.
  useEffect(() => {
    let canceled = false;
    let retryNeeded = false;
    async function restore() {
      const recovered = readDraft(recoveryKey, wrapUpDraftSchema);
      if (recovered?.mode === "IN_APP" && recovered.callId) {
        try {
          const [status, context] = await Promise.all([
            getCallStatusAction(recovered.callId), getIncomingCallContextAction(recovered.callId),
          ]);
          if (canceled) return;
          const decision = recoverWrapUp(recovered, status, context);
          if (decision.kind === "discard") {
            removeDraft(recoveryKey);
            removeDraft(draftKey(userId, "outcome", recovered.callId));
            return;
          }
          if (decision.kind === "retry") { retryNeeded = true; return; }
          dispatch({ type: "RESTORE_WRAP_UP", wrapUp: decision.wrapUp });
          toast(t.dialerRecovery.restored);
        } catch { retryNeeded = true; }
        return;
      }
      const now = Date.now();
      const pending = readPendingTel(now, userId);
      if (!pending) { clearPendingTel(); return; }
      if (pending.stage === "wrap-up" || shouldOpenTelOutcome(pending, now)) {
        writePendingTel({ ...pending, stage: "wrap-up" });
        dispatch({ type: "RESTORE_WRAP_UP", wrapUp: pendingTelWrapUp(pending) });
      } else {
        dispatch({ type: "TEL_START", leadId: pending.leadId, callId: pending.callId, label: pending.label,
          clientRequestId: pending.clientRequestId, startedAt: pending.startedAt });
      }
    }
    void restore().finally(() => {
      if (!canceled) {
        recoveringRef.current = retryNeeded;
        setRecovering(retryNeeded);
        setRecoveryError(retryNeeded);
      }
    });
    return () => { canceled = true; };
  }, [dispatch, userId, recoveryKey, recoveryAttempt, t.dialerRecovery.restored]);

  useEffect(() => {
    if (state.kind === "idle" || state.kind === "incoming" || state.kind === "tel-pending") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state.kind]);

  const handleIncoming = useCallback(
    (call: IncomingCall) => {
      if (recoveringRef.current || manualTelStartingRef.current || stateRef.current.kind !== "idle") {
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
        if (notify) toast(t.dialerErrors.inAppUnavailable, { id: "dialer-device" });
      },
      registerTimeoutMs: REGISTER_TIMEOUT_MS,
      retryMs: REGISTER_RETRY_MS,
    });
    sessionRef.current = session;
    return () => {
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [shouldRegister, defaultDriver, handleIncoming, t.dialerErrors.inAppUnavailable]);

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
  const connecting = recovering || (
    device === "registering" &&
    resolveDialMode({ preference, defaultDriver, isIOS, inAppEnabled, deviceReady: true }) === "in-app");

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

  const startOutboundCall = useCallback(
    async (subject: CallSubject, requestCallId: () => Promise<ManualCallRequest>) => {
      const driver = sessionRef.current?.readyDriver() ?? null;
      if (!canStartManualDial(stateRef.current, recoveringRef.current) || manualTelStartingRef.current || !driver) return;

      const token = callTokenRef.current + 1;
      callTokenRef.current = token;
      dispatch({ type: "OUTBOUND_START", subject });
      const isCurrent = () => callTokenRef.current === token;
      const abort = (message: string | null) => {
        if (!isCurrent()) return;
        dispatch({ type: "OUTBOUND_ABORTED" });
        if (message) toast.error(message);
      };

      const micError = await ensureMicrophone(driver);
      if (micError) return abort(micError);
      if (cancelTokenRef.current === token) return abort(null);

      const result = await requestCallId();
      if (!result.ok) {
        // A disabled or unavailable device should stop offering browser calls.
        if (result.status === 403) {
          sessionRef.current?.turnOff();
          router.refresh();
        } else if (result.status === 503) {
          sessionRef.current?.markUnavailable();
        }
        return abort(result.message);
      }
      const callId = result.callId;
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
        if (isCurrent()) {
          dispatch({ type: "DISCONNECTED", reason: "failed" });
          toast.error(t.dialerErrors.startFailed);
        }
      }
    },
    [dispatch, ensureMicrophone, recheckServerStatus, router, t.dialerErrors.startFailed],
  );

  const startCall = useCallback((lead: DialableLead) => {
    if (!isDialable(lead.status) || !E164_PATTERN.test(lead.phone)) return;
    return startOutboundCall({ leadId: lead.id, label: lead.businessName }, () => requestLeadCallId(lead.id, t.dialerErrors));
  }, [startOutboundCall, t.dialerErrors]);

  const startManualCall = useCallback(async (target: ManualDialTarget): Promise<void> => {
    await startOutboundCall({ leadId: null, label: target.label }, () => requestManualCallId(target, "IN_APP"));
  }, [startOutboundCall]);

  const beginTelCall = useCallback(
    (lead: DialableLead): boolean => {
      if (manualTelStartingRef.current || recoveringRef.current || stateRef.current.kind !== "idle" || !isDialable(lead.status) || !E164_PATTERN.test(lead.phone)) return false;
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

  const beginManualTelCall = useCallback(async (target: ManualDialTarget): Promise<boolean> => {
    if (!canStartManualDial(stateRef.current, recoveringRef.current) || manualTelStartingRef.current) return false;
    manualTelStartingRef.current = true;
    try {
      const result = await requestManualCallId(target, "TEL");
      if (!result.ok) {
        toast.error(result.message);
        return false;
      }
      if (!canStartManualDial(stateRef.current, recoveringRef.current)) return false;
      const pending = {
        userId, leadId: null, callId: result.callId, label: target.label,
        clientRequestId: newClientRequestId(), startedAt: Date.now(), stage: "calling" as const,
      };
      writePendingTel(pending);
      dispatch({
        type: "TEL_START", leadId: null, callId: pending.callId, label: pending.label,
        clientRequestId: pending.clientRequestId, startedAt: pending.startedAt,
      });
      return stateRef.current.kind === "tel-pending" && stateRef.current.callId === result.callId;
    } finally {
      manualTelStartingRef.current = false;
    }
  }, [dispatch, userId]);

  const openTelOutcome = useCallback(() => {
    const current = stateRef.current;
    if (current.kind !== "tel-pending") return;
    writePendingTel({
      userId,
      leadId: current.subject.leadId,
      callId: current.callId,
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

  const setInputDevice = useCallback(async (deviceId: string): Promise<boolean> => {
    const driver = sessionRef.current?.loadedDriver() ?? null;
    if (!driver?.setInputDevice) return false;
    await driver.setInputDevice(deviceId);
    return true;
  }, []);

  const setOutputDevice = useCallback(async (deviceId: string): Promise<boolean> => {
    const driver = sessionRef.current?.loadedDriver() ?? null;
    if (!driver?.setOutputDevice) return false;
    await driver.setOutputDevice(deviceId);
    return true;
  }, []);

  const testSpeaker = useCallback(async (): Promise<boolean> => {
    const driver = sessionRef.current?.loadedDriver() ?? null;
    if (!driver?.testSpeaker) return false;
    await driver.testSpeaker();
    return true;
  }, []);

  // Re-apply the microphone and speaker chosen in Settings each time the in-app device (re)registers.
  useEffect(() => {
    if (device !== "ready") return;
    let input: string | null = null;
    let output: string | null = null;
    try {
      input = window.localStorage.getItem(AUDIO_INPUT_STORAGE_KEY);
      output = window.localStorage.getItem(AUDIO_OUTPUT_STORAGE_KEY);
    } catch {
      return;
    }
    // A device that was unplugged is simply not applied; the browser default stays in use.
    if (input) void setInputDevice(input).catch(() => undefined);
    if (output) void setOutputDevice(output).catch(() => undefined);
  }, [device, setInputDevice, setOutputDevice]);

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
      toast.error(t.dialerErrors.acceptFailed);
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
  }, [declineIncoming, dispatch, endIncoming, ensureMicrophone, t.dialerErrors.acceptFailed]);

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
    removeDraft(recoveryKey);
    dispatch({ type: "WRAP_UP_DONE" });
  }, [dispatch, recoveryKey]);

  const handleSaved = useCallback(
    (goNext: boolean) => {
      finishWrapUp();
      toast.success(goNext ? t.dialerRecovery.savedNext : t.dialerRecovery.saved);
      notifyVoicemailsChanged();
      if (goNext) router.push(nextLeadHref(currentSkipList()));
      else router.refresh();
    },
    [finishWrapUp, router, t.dialerRecovery.saved, t.dialerRecovery.savedNext],
  );

  const markMeetingBooked = useCallback((leadId: string) => dispatch({ type: "MEETING_BOOKED", leadId }), [dispatch]);

  const value = useMemo<DialerContextValue>(
    () => ({
      state,
      timezone,
      dialMode,
      connecting,
      startCall: (lead) => void startCall(lead),
      startManualCall,
      beginTelCall,
      beginManualTelCall,
      hangup,
      setMuted,
      sendDigits,
      markMeetingBooked,
      deviceReady,
      setInputDevice,
      setOutputDevice,
      testSpeaker,
    }),
    [
      state,
      timezone,
      dialMode,
      connecting,
      startCall,
      startManualCall,
      beginTelCall,
      beginManualTelCall,
      hangup,
      setMuted,
      sendDigits,
      markMeetingBooked,
      deviceReady,
      setInputDevice,
      setOutputDevice,
      testSpeaker,
    ],
  );

  return (
    <DialerContext.Provider value={value}>
      {children}
      <PersistentKeypad />
      {recoveryError ? (
        <section role="alert" className="fixed inset-x-4 bottom-24 z-50 rounded-xl border bg-card p-4 shadow-lg md:left-64">
          <p className="font-bold">{t.dialerRecovery.failedTitle}</p>
          <p className="mt-1 text-sm">{t.dialerRecovery.failedDescription}</p>
          <button type="button" className="mt-2 min-h-12 rounded-lg border px-4 font-bold focus-visible:ring-3 focus-visible:ring-ring/50" onClick={() => { setRecoveryError(false); setRecoveryAttempt((attempt) => attempt + 1); }}>{t.dialerRecovery.retry}</button>
        </section>
      ) : null}
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
          userId={userId}
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

import type { ActiveCall, CallEndReason, CallEvents, InAppDriver, IncomingCall } from "../types";

export interface MockDriverOptions {
  ringMs?: number;
  /** Installs window.__fmqMockDialer. Only when DIALER_DRIVER=mock. */
  exposeTestHooks?: boolean;
}

export interface MockDialerSnapshot {
  inCall: boolean;
  connected: boolean;
  muted: boolean;
  digits: string;
  incomingPending: boolean;
}

export interface MockDialerTestHooks {
  /** Ends the active call as if the other party hung up, or cancels an unanswered incoming call. */
  remoteHangup(reason?: CallEndReason): void;
  simulateIncoming(callId: string | null): void;
  snapshot(): MockDialerSnapshot;
}

declare global {
  interface Window {
    __fmqMockDialer?: MockDialerTestHooks;
  }
}

interface Session {
  events: CallEvents;
  connected: boolean;
  ended: boolean;
  muted: boolean;
  digits: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingIncoming {
  settled: boolean;
  cancelListeners: Set<() => void>;
}

/** Simulated calls with no provider: ringing, connected after `ringMs`, then connected until hangup. */
export function createMockDriver(options: MockDriverOptions = {}): InAppDriver {
  const ringMs = options.ringMs ?? 1200;
  const incomingListeners = new Set<(call: IncomingCall) => void>();
  let destroyed = false;
  let current: Session | null = null;
  let pendingIncoming: PendingIncoming | null = null;

  function end(session: Session, reason: CallEndReason): void {
    if (session.ended) return;
    session.ended = true;
    if (session.timer !== null) clearTimeout(session.timer);
    session.timer = null;
    if (current === session) current = null;
    session.events.onDisconnected(reason);
  }

  function activeCall(session: Session): ActiveCall {
    return {
      hangup: () => end(session, session.connected ? "completed" : "canceled"),
      setMuted: (muted) => {
        if (!session.ended) session.muted = muted;
      },
      isMuted: () => session.muted,
      sendDigits: (digits) => {
        if (!session.ended && session.connected) session.digits += digits;
      },
    };
  }

  function newSession(events: CallEvents, connected: boolean): Session {
    return { events, connected, ended: false, muted: false, digits: "", timer: null };
  }

  const hooks: MockDialerTestHooks = {
    remoteHangup(reason = "completed") {
      if (current) {
        end(current, reason);
        return;
      }
      if (pendingIncoming && !pendingIncoming.settled) {
        const pending = pendingIncoming;
        pending.settled = true;
        pendingIncoming = null;
        for (const listener of pending.cancelListeners) listener();
      }
    },
    simulateIncoming(callId) {
      if (destroyed) return;
      const pending: PendingIncoming = { settled: false, cancelListeners: new Set() };
      pendingIncoming = pending;
      const call: IncomingCall = {
        callId,
        accept(events) {
          if (pending.settled) throw new Error("This call is no longer ringing");
          if (current) throw new Error("A call is already active");
          pending.settled = true;
          if (pendingIncoming === pending) pendingIncoming = null;
          const session = newSession(events, true);
          current = session;
          events.onConnected();
          return activeCall(session);
        },
        reject() {
          pending.settled = true;
          if (pendingIncoming === pending) pendingIncoming = null;
        },
        onCancel(listener) {
          pending.cancelListeners.add(listener);
        },
      };
      for (const listener of incomingListeners) listener(call);
    },
    snapshot() {
      return {
        inCall: current !== null,
        connected: current?.connected ?? false,
        muted: current?.muted ?? false,
        digits: current?.digits ?? "",
        incomingPending: pendingIncoming !== null && !pendingIncoming.settled,
      };
    },
  };

  const installHooks = options.exposeTestHooks === true && typeof window !== "undefined";
  if (installHooks) window.__fmqMockDialer = hooks;

  return {
    name: "mock",
    async register() {
      return destroyed ? { ok: false, reason: "The dialer was shut down" } : { ok: true };
    },
    async connect(callId, events) {
      if (destroyed) throw new Error("The dialer was shut down");
      if (!callId) throw new Error("A call id is required");
      if (current) throw new Error("A call is already active");
      const session = newSession(events, false);
      current = session;
      events.onRinging();
      session.timer = setTimeout(() => {
        session.timer = null;
        if (session.ended) return;
        session.connected = true;
        events.onConnected();
      }, ringMs);
      return activeCall(session);
    },
    onIncoming(listener) {
      incomingListeners.add(listener);
      return () => {
        incomingListeners.delete(listener);
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (current) {
        const session = current;
        if (session.timer !== null) clearTimeout(session.timer);
        session.ended = true;
        current = null;
      }
      pendingIncoming = null;
      incomingListeners.clear();
      if (installHooks && window.__fmqMockDialer === hooks) delete window.__fmqMockDialer;
    },
  };
}

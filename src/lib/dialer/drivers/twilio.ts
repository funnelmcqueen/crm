import { Device, type Call } from "@twilio/voice-sdk";
import type { ActiveCall, CallEvents, DriverState, InAppDriver, IncomingCall, RegisterResult } from "@/lib/dialer/types";

export interface TwilioDriverOptions {
  /** POST /api/voice/token. Called on register and whenever the token is about to expire. */
  fetchToken(): Promise<{ token: string; ttl: number }>;
}

export const REGISTER_TIMEOUT_MS = 10_000;
/** The Device announces `tokenWillExpire` this long before expiry, which is the window for refresh retries. */
export const TOKEN_REFRESH_MS = 60_000;
const TOKEN_RETRY_BASE_MS = 2_000;
const TOKEN_RETRY_MAX_MS = 16_000;
/** Stop retrying this long before the token actually expires. */
const TOKEN_RETRY_MARGIN_MS = 2_000;

const MICROPHONE_BLOCKED = "Microphone blocked";
const MICROPHONE_NOT_FOUND = "Microphone not found";
const CONNECTION_LOST = "Connection lost";
const POOR_CONNECTION = "Poor connection";
const MICROPHONE_SILENT = "Microphone is not picking up audio";

const ERROR_MESSAGES: Readonly<Record<number, string>> = {
  31401: MICROPHONE_BLOCKED,
  31208: MICROPHONE_BLOCKED,
  31201: MICROPHONE_NOT_FOUND,
  31005: CONNECTION_LOST,
  31009: CONNECTION_LOST,
  53000: CONNECTION_LOST,
  53405: CONNECTION_LOST,
};

/** AccessTokenExpired (20104) and the older JWT-expired code (31205): the Device can no longer connect. */
const TOKEN_EXPIRED_CODES: ReadonlySet<number> = new Set([20104, 31205]);

const WARNING_MESSAGES: Readonly<Record<string, string>> = {
  "high-rtt": POOR_CONNECTION,
  "high-jitter": POOR_CONNECTION,
  "high-packet-loss": POOR_CONNECTION,
  "low-mos": POOR_CONNECTION,
  "constant-audio-input-level": MICROPHONE_SILENT,
};

/** Plain-language message for a Twilio error or a browser media error. Never shows raw SDK text. */
export function twilioErrorMessage(error: unknown, fallback = "Call failed"): string {
  if (typeof error === "object" && error !== null) {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (typeof code === "number" && Object.hasOwn(ERROR_MESSAGES, code)) return ERROR_MESSAGES[code];
    if (name === "NotAllowedError" || name === "PermissionDeniedError") return MICROPHONE_BLOCKED;
    if (name === "NotFoundError" || name === "DevicesNotFoundError") return MICROPHONE_NOT_FOUND;
  }
  return fallback;
}

export function twilioWarningMessage(name: unknown): string | null {
  return typeof name === "string" && Object.hasOwn(WARNING_MESSAGES, name) ? WARNING_MESSAGES[name] : null;
}

/** `Call.State` values as strings, so this module does not depend on the SDK enum at runtime. */
function callStatus(call: Call): string {
  return String(call.status());
}

function wireCall(call: Call, events: CallEvents): ActiveCall {
  let ended = false;
  const end = (reason: Parameters<CallEvents["onDisconnected"]>[0]) => {
    if (ended) return;
    ended = true;
    events.onDisconnected(reason);
  };
  call.on("ringing", () => events.onRinging());
  call.on("accept", () => events.onConnected());
  call.on("disconnect", () => end("completed"));
  call.on("cancel", () => end("canceled"));
  call.on("reject", () => end("busy"));
  call.on("error", (error: unknown) => events.onError(twilioErrorMessage(error)));
  call.on("warning", (name: unknown) => {
    const message = twilioWarningMessage(name);
    if (message) events.onWarning(message);
  });
  call.on("warning-cleared", () => events.onWarning(""));
  return {
    // The SDK ignores disconnect() on a closed call and emits nothing, so end it here instead.
    hangup: () => {
      if (callStatus(call) === "closed") end("completed");
      else call.disconnect();
    },
    setMuted: (muted) => call.mute(muted),
    isMuted: () => call.isMuted(),
    sendDigits: (digits) => call.sendDigits(digits),
  };
}

function toIncomingCall(call: Call): IncomingCall {
  let accepted = false;
  let declined = false;
  let canceled = false;
  const cancelListeners = new Set<() => void>();
  // The SDK emits `cancel` once (caller hung up, the Dial timed out, or another tab answered) and then
  // ignores accept(); listening from arrival is the only way to notice it.
  const onEndedBeforeAnswer = () => {
    if (accepted || declined || canceled) return;
    canceled = true;
    for (const listener of cancelListeners) listener();
    cancelListeners.clear();
  };
  call.on("cancel", onEndedBeforeAnswer);
  call.on("disconnect", onEndedBeforeAnswer);
  call.on("reject", onEndedBeforeAnswer);

  return {
    callId: call.customParameters.get("callId") ?? null,
    accept(events) {
      if (canceled || declined || callStatus(call) !== "pending") throw new Error("This call is no longer ringing");
      accepted = true;
      const active = wireCall(call, events);
      call.accept();
      return active;
    },
    reject() {
      declined = true;
      cancelListeners.clear();
      call.reject();
    },
    onCancel(listener) {
      if (canceled) listener();
      else if (!accepted && !declined) cancelListeners.add(listener);
    },
  };
}

/** The only module that imports @twilio/voice-sdk (ARCHITECTURE golden rule 7). Browser only. */
export function createTwilioDriver(options: TwilioDriverOptions): InAppDriver {
  let device: Device | null = null;
  let registered = false;
  let registering: Promise<RegisterResult> | null = null;
  let lastState: DriverState | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshing = false;
  const incomingListeners = new Set<(call: IncomingCall) => void>();
  const stateListeners = new Set<(state: DriverState) => void>();

  function setState(state: DriverState): void {
    if (lastState === state) return;
    lastState = state;
    for (const listener of [...stateListeners]) listener(state);
  }

  function stopRefresh(): void {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    refreshing = false;
  }

  /** Retries with backoff until the old token is about to expire; then the device is reported unavailable. */
  function refreshToken(target: Device): void {
    if (refreshing) return;
    refreshing = true;
    const deadline = Date.now() + TOKEN_REFRESH_MS - TOKEN_RETRY_MARGIN_MS;
    let delay = TOKEN_RETRY_BASE_MS;
    const attempt = () => {
      refreshTimer = null;
      options
        .fetchToken()
        .then(({ token }) => {
          if (device !== target) return;
          target.updateToken(token);
          refreshing = false;
        })
        .catch(() => {
          if (device !== target) return;
          if (Date.now() + delay > deadline) {
            refreshing = false;
            setState("unavailable");
            return;
          }
          refreshTimer = setTimeout(attempt, delay);
          delay = Math.min(delay * 2, TOKEN_RETRY_MAX_MS);
        });
    };
    attempt();
  }

  function createDevice(token: string): Device {
    const created = new Device(token, {
      codecPreferences: ["opus", "pcmu"] as Call.Codec[],
      closeProtection: true,
      tokenRefreshMs: TOKEN_REFRESH_MS,
    });
    created.on("incoming", (call: Call) => {
      const incoming = toIncomingCall(call);
      for (const listener of incomingListeners) listener(incoming);
    });
    created.on("tokenWillExpire", () => refreshToken(created));
    created.on("registered", () => {
      registered = true;
      setState("ready");
    });
    created.on("unregistered", () => {
      registered = false;
      setState("unavailable");
    });
    created.on("error", (error: unknown) => {
      const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
      if (typeof code === "number" && TOKEN_EXPIRED_CODES.has(code)) setState("unavailable");
    });
    return created;
  }

  async function doRegister(): Promise<RegisterResult> {
    let current: Device;
    try {
      const { token } = await options.fetchToken();
      if (device) device.updateToken(token);
      else device = createDevice(token);
      current = device;
    } catch (error) {
      return { ok: false, reason: twilioErrorMessage(error, "Could not start in-app calling") };
    }
    if (registered) {
      setState("ready");
      return { ok: true };
    }

    return new Promise<RegisterResult>((resolve) => {
      let settled = false;
      const finish = (result: RegisterResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        current.removeListener("registered", onRegistered);
        current.removeListener("error", onError);
        resolve(result);
      };
      const onRegistered = () => finish({ ok: true });
      const onError = (error: unknown) => finish({ ok: false, reason: twilioErrorMessage(error, "Could not start in-app calling") });
      const timer = setTimeout(() => finish({ ok: false, reason: "Timed out starting in-app calling" }), REGISTER_TIMEOUT_MS);
      current.on("registered", onRegistered);
      current.on("error", onError);
      current.register().catch(onError);
    });
  }

  return {
    name: "twilio",

    register() {
      registering ??= doRegister().finally(() => {
        registering = null;
      });
      return registering;
    },

    onStateChange(cb) {
      stateListeners.add(cb);
      return () => {
        stateListeners.delete(cb);
      };
    },

    async connect(callId, events) {
      if (!device) throw new Error("In-app calling is not ready");
      let call: Call;
      try {
        call = await device.connect({ params: { callId } });
      } catch (error) {
        throw new Error(twilioErrorMessage(error));
      }
      return wireCall(call, events);
    },

    onIncoming(cb) {
      incomingListeners.add(cb);
      return () => {
        incomingListeners.delete(cb);
      };
    },

    async setInputDevice(deviceId) {
      if (!device?.audio) throw new Error("Audio devices are not available");
      await device.audio.setInputDevice(deviceId);
    },

    async setOutputDevice(deviceId) {
      if (!device?.audio) throw new Error("Audio devices are not available");
      await device.audio.speakerDevices.set(deviceId);
    },

    async testSpeaker() {
      if (!device?.audio) throw new Error("Audio devices are not available");
      await device.audio.speakerDevices.test();
    },

    destroy() {
      incomingListeners.clear();
      stateListeners.clear();
      stopRefresh();
      const current = device;
      device = null;
      registered = false;
      if (!current) return;
      current.unregister().catch(() => undefined);
      current.destroy();
    },
  };
}

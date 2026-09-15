import type { DriverState, InAppDriver, IncomingCall, RegisterResult } from "./types";

export type DeviceStatus = "off" | "registering" | "ready" | "failed";

export interface DeviceSessionOptions {
  load(): Promise<InAppDriver>;
  onIncoming(call: IncomingCall): void;
  /** `notify` is true when the agent should be told that calls now use their phone. */
  onStatus(status: DeviceStatus, notify: boolean): void;
  /** After this long without a registration the UI falls back to tel:. A later success still counts. */
  registerTimeoutMs: number;
  /** How often a failed or lost device tries to register again. */
  retryMs: number;
}

export interface DeviceSession {
  status(): DeviceStatus;
  /** The driver for new outbound calls: only while registered. */
  readyDriver(): InAppDriver | null;
  /** The loaded driver whatever its status, e.g. to answer a call that rang on a late registration. */
  loadedDriver(): InAppDriver | null;
  /** The server refused in-app calling for this user (403): drop the device for the rest of the session. */
  turnOff(): void;
  /** The server could not start an in-app call (503): use tel: for now and register again later. */
  markUnavailable(): void;
  dispose(): void;
}

/**
 * The in-app device lifecycle behind DialerProvider. Never leaves a registered device without a driver
 * the UI can use, and never keeps reporting "ready" (which drives presence heartbeats and inbound
 * routing) for a device that stopped working.
 */
export function startDeviceSession(options: DeviceSessionOptions): DeviceSession {
  let status: DeviceStatus = "registering";
  let driver: InAppDriver | null = null;
  let stopped = false;
  let registerInFlight = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let registerTimer: ReturnType<typeof setTimeout> | null = null;
  const cleanups: Array<() => void> = [];

  function setStatus(next: DeviceStatus, notify: boolean): void {
    if (stopped || status === next) return;
    status = next;
    if (registerTimer !== null) {
      clearTimeout(registerTimer);
      registerTimer = null;
    }
    options.onStatus(next, notify);
  }

  function scheduleRetry(): void {
    if (stopped || retryTimer !== null || driver === null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (status === "failed") void register();
    }, options.retryMs);
  }

  async function register(): Promise<void> {
    const current = driver;
    if (current === null || stopped || registerInFlight) return;
    registerInFlight = true;
    let result: RegisterResult;
    try {
      result = await current.register();
    } catch {
      result = { ok: false, reason: "register threw" };
    } finally {
      registerInFlight = false;
    }
    if (stopped || driver !== current) return;
    if (result.ok) {
      setStatus("ready", false);
      return;
    }
    setStatus("failed", true);
    scheduleRetry();
  }

  function onDriverState(state: DriverState): void {
    if (stopped) return;
    if (state === "ready") {
      setStatus("ready", false);
      return;
    }
    if (status === "ready") {
      setStatus("failed", true);
      scheduleRetry();
    }
  }

  function teardown(): void {
    stopped = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (registerTimer !== null) clearTimeout(registerTimer);
    retryTimer = null;
    registerTimer = null;
    for (const cleanup of cleanups.splice(0)) cleanup();
    const current = driver;
    driver = null;
    current?.destroy();
  }

  registerTimer = setTimeout(() => {
    registerTimer = null;
    if (status === "registering") setStatus("failed", true);
  }, options.registerTimeoutMs);

  void (async () => {
    let loaded: InAppDriver;
    try {
      loaded = await options.load();
    } catch {
      setStatus("failed", true);
      return;
    }
    if (stopped) {
      loaded.destroy();
      return;
    }
    driver = loaded;
    cleanups.push(loaded.onIncoming(options.onIncoming));
    if (loaded.onStateChange) cleanups.push(loaded.onStateChange(onDriverState));
    await register();
  })();

  return {
    status: () => status,
    readyDriver: () => (status === "ready" ? driver : null),
    loadedDriver: () => driver,
    turnOff() {
      if (stopped) return;
      setStatus("off", false);
      teardown();
    },
    markUnavailable() {
      if (stopped) return;
      setStatus("failed", false);
      scheduleRetry();
    },
    dispose: teardown,
  };
}

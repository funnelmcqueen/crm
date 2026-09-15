import type { InAppDriver } from "../types";

export interface LoadInAppDriverOptions {
  /** POST /api/voice/token. Used by the twilio driver only. */
  fetchToken(): Promise<{ token: string; ttl: number }>;
  ringMs?: number;
  exposeTestHooks?: boolean;
}

/** Dynamic imports keep the Voice SDK out of the bundle unless the twilio driver is in use. */
export async function loadInAppDriver(name: "twilio" | "mock", options: LoadInAppDriverOptions): Promise<InAppDriver> {
  if (name === "twilio") {
    const { createTwilioDriver } = await import("./twilio");
    return createTwilioDriver({ fetchToken: options.fetchToken });
  }
  const { createMockDriver } = await import("./mock");
  return createMockDriver({ ringMs: options.ringMs, exposeTestHooks: options.exposeTestHooks });
}

// README and .env.example both promise that an invalid environment stops the server: "DIALER_DRIVER=mock
// together with NODE_ENV=production is an invalid environment and the server fails to start (D24)".
// That was not true. src/server/env.ts is deliberately lazy (importing it never throws), so nothing
// validated at boot: `next start` came up healthy, served /login with a 200, and only the routes that
// call getServerEnv() failed, one 500 at a time, on the calling path D24 exists to protect.
//
// instrumentation.ts is Next's boot hook: `register` runs once before the server accepts requests.
// Throwing there is necessary but not sufficient — Next logs the failed hook and keeps serving, so
// register also exits. `exit` is injected here so the assertion does not end the test runner.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";
import { resetEnvCacheForTests } from "@/server/env";

const VALID = {
  NODE_ENV: "production",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
};

const ENV_KEYS = [
  "NODE_ENV",
  "NEXT_RUNTIME",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "APP_BASE_URL",
  "DIALER_DRIVER",
] as const;

function stubEnv(values: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
  resetEnvCacheForTests();
}

/** Runs register with a fake exit, returning what it threw and whether it aborted. */
async function boot(): Promise<{ error: Error | null; exitCodes: number[] }> {
  const exitCodes: number[] = [];
  try {
    await register({ exit: (code) => exitCodes.push(code) });
    return { error: null, exitCodes };
  } catch (thrown) {
    return { error: thrown instanceof Error ? thrown : new Error(String(thrown)), exitCodes };
  }
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCacheForTests();
});

describe("register (instrumentation)", () => {
  it("starts normally with a valid environment", async () => {
    stubEnv({ ...VALID, NEXT_RUNTIME: "nodejs" });
    const { error, exitCodes } = await boot();
    expect(error).toBeNull();
    expect(exitCodes).toEqual([]);
  });

  it("stops the server when DIALER_DRIVER=mock in production (D24)", async () => {
    stubEnv({ ...VALID, NEXT_RUNTIME: "nodejs", DIALER_DRIVER: "mock" });
    const { error, exitCodes } = await boot();
    expect(error?.message).toMatch(/DIALER_DRIVER/);
    expect(error?.message).toMatch(/production/);
    // Throwing alone leaves Next serving 500s; the abort is what actually stops startup.
    expect(exitCodes).toEqual([1]);
  });

  it("stops the server when a required variable is missing, naming it without echoing values", async () => {
    stubEnv({ ...VALID, NEXT_RUNTIME: "nodejs", SUPABASE_SERVICE_ROLE_KEY: undefined });
    const { error, exitCodes } = await boot();
    expect(error?.message).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(error?.message).not.toContain("anon-key-value");
    expect(exitCodes).toEqual([1]);
  });

  it("leaves other runtimes alone: the app only ever runs on Node", async () => {
    stubEnv({ ...VALID, NEXT_RUNTIME: "edge", DIALER_DRIVER: "mock" });
    const { error, exitCodes } = await boot();
    expect(error).toBeNull();
    expect(exitCodes).toEqual([]);
  });
});

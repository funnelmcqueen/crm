import { describe, expect, it } from "vitest";
import { getCalendarDriver, isGoogleCalendarConfigured, parseServerEnv } from "@/server/env";

const BASE = {
  NODE_ENV: "development",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321/",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
};

// Obvious fakes — never a real client id/secret or key.
const GOOGLE_KEYS_ONLY = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 0).toString("base64"),
};
const GOOGLE = { ...GOOGLE_KEYS_ONLY, APP_BASE_URL: "https://crm.example.com" };

function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`expected an Error, got ${String(err)}`);
  }
  throw new Error("expected the call to throw");
}

describe("CALENDAR_DRIVER", () => {
  it("defaults to the mock calendar outside production and to unavailable in production", () => {
    expect(getCalendarDriver(parseServerEnv(BASE))).toBe("mock");
    expect(getCalendarDriver(parseServerEnv({ ...BASE, NODE_ENV: "production" }))).toBe("unavailable");
  });

  it("uses an explicit value, case-insensitively", () => {
    expect(getCalendarDriver(parseServerEnv({ ...BASE, ...GOOGLE, CALENDAR_DRIVER: " Google " }))).toBe("google");
  });

  it("refuses the mock calendar in production", () => {
    expect(() => parseServerEnv({ ...BASE, NODE_ENV: "production", CALENDAR_DRIVER: "mock" })).toThrow(/CALENDAR_DRIVER must not be mock in production/);
  });

  it("rejects an unknown driver", () => {
    expect(() => parseServerEnv({ ...BASE, CALENDAR_DRIVER: "outlook" })).toThrow(/CALENDAR_DRIVER/);
  });

  it("auto-detects google when CALENDAR_DRIVER is unset and all three GOOGLE_* variables plus APP_BASE_URL are present, in and outside production", () => {
    expect(getCalendarDriver(parseServerEnv({ ...BASE, ...GOOGLE }))).toBe("google");
    expect(getCalendarDriver(parseServerEnv({ ...BASE, ...GOOGLE, NODE_ENV: "production" }))).toBe("google");
  });

  it("keeps milestone 1 behaviour when CALENDAR_DRIVER is unset and the Google variables are absent", () => {
    expect(getCalendarDriver(parseServerEnv(BASE))).toBe("mock");
    expect(getCalendarDriver(parseServerEnv({ ...BASE, NODE_ENV: "production" }))).toBe("unavailable");
  });

  it("keeps milestone 1 behaviour when only some Google variables are present", () => {
    expect(getCalendarDriver(parseServerEnv({ ...BASE, GOOGLE_CLIENT_ID: GOOGLE.GOOGLE_CLIENT_ID }))).toBe("mock");
    expect(
      getCalendarDriver(parseServerEnv({ ...BASE, GOOGLE_CLIENT_ID: GOOGLE.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: GOOGLE.GOOGLE_CLIENT_SECRET })),
    ).toBe("mock");
  });

  it("lets an explicit CALENDAR_DRIVER win over auto-detection from the Google variables", () => {
    expect(getCalendarDriver(parseServerEnv({ ...BASE, ...GOOGLE, CALENDAR_DRIVER: "mock" }))).toBe("mock");
  });

  it("still refuses mock in production even with the Google variables present", () => {
    expect(() => parseServerEnv({ ...BASE, ...GOOGLE, NODE_ENV: "production", CALENDAR_DRIVER: "mock" })).toThrow(
      /CALENDAR_DRIVER must not be mock in production/,
    );
  });
});

describe("isGoogleCalendarConfigured", () => {
  it("needs all three Google variables, non-blank, and APP_BASE_URL", () => {
    expect(isGoogleCalendarConfigured(parseServerEnv({ ...BASE, ...GOOGLE }))).toBe(true);
    expect(isGoogleCalendarConfigured(parseServerEnv({ ...BASE, GOOGLE_CLIENT_ID: GOOGLE.GOOGLE_CLIENT_ID }))).toBe(false);
    expect(isGoogleCalendarConfigured(parseServerEnv({ ...BASE, ...GOOGLE, GOOGLE_TOKEN_ENCRYPTION_KEY: "   " }))).toBe(false);
    expect(isGoogleCalendarConfigured(parseServerEnv(BASE))).toBe(false);
  });

  it("is false when APP_BASE_URL is missing even though the three Google variables are all set", () => {
    // CALENDAR_DRIVER is forced to "mock" here so parseServerEnv itself does not throw (below): with an
    // explicit non-google driver, the superRefine requirement that APP_BASE_URL accompany a resolved google
    // driver never triggers, so this is a legitimate ServerEnv to hand isGoogleCalendarConfigured.
    const env = parseServerEnv({ ...BASE, ...GOOGLE_KEYS_ONLY, CALENDAR_DRIVER: "mock" });
    expect(isGoogleCalendarConfigured(env)).toBe(false);
  });
});

// I4: an owner who set the three GOOGLE_* variables but not APP_BASE_URL used to boot fine, see "Connect
// Google Calendar" in Settings, and get a bare {"error":"unavailable"} 503 from /api/google/start the first
// time anyone clicked it. This mirrors the DIALER_DRIVER=twilio checks in tests/unit/server/env.test.ts.
describe("CALENDAR_DRIVER=google requires the Google variables and APP_BASE_URL at startup", () => {
  it("requires every Google variable and APP_BASE_URL when CALENDAR_DRIVER=google is explicit", () => {
    const err = thrownBy(() => parseServerEnv({ ...BASE, CALENDAR_DRIVER: "google", GOOGLE_CLIENT_ID: GOOGLE.GOOGLE_CLIENT_ID }));
    for (const key of ["GOOGLE_CLIENT_SECRET", "GOOGLE_TOKEN_ENCRYPTION_KEY", "APP_BASE_URL"]) {
      expect(err.message).toContain(key);
    }
    expect(err.message).not.toContain("GOOGLE_CLIENT_ID is required");
  });

  it("requires APP_BASE_URL too when CALENDAR_DRIVER is unset and the three Google variables alone would auto-detect it", () => {
    const err = thrownBy(() => parseServerEnv({ ...BASE, ...GOOGLE_KEYS_ONLY }));
    expect(err.message).toContain("APP_BASE_URL");
  });

  it("does not require APP_BASE_URL when only some Google variables are present (no auto-detect, no forced driver)", () => {
    expect(parseServerEnv({ ...BASE, GOOGLE_CLIENT_ID: GOOGLE.GOOGLE_CLIENT_ID }).APP_BASE_URL).toBeUndefined();
  });

  it("rejects a GOOGLE_TOKEN_ENCRYPTION_KEY that does not decode to 32 bytes", () => {
    const err = thrownBy(() =>
      parseServerEnv({ ...BASE, ...GOOGLE, GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 0).toString("base64") }),
    );
    expect(err.message).toContain("GOOGLE_TOKEN_ENCRYPTION_KEY");
    expect(err.message).toMatch(/32 bytes/);
  });

  it("succeeds once all three Google variables and APP_BASE_URL are set", () => {
    expect(getCalendarDriver(parseServerEnv({ ...BASE, ...GOOGLE }))).toBe("google");
  });
});

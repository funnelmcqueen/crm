import { describe, expect, it } from "vitest";
import { getCalendarDriver, isGoogleCalendarConfigured, parseServerEnv } from "@/server/env";

const BASE = {
  NODE_ENV: "development",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321/",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
};

// Obvious fakes — never a real client id/secret or key.
const GOOGLE = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 0).toString("base64"),
};

describe("CALENDAR_DRIVER", () => {
  it("defaults to the mock calendar outside production and to unavailable in production", () => {
    expect(getCalendarDriver(parseServerEnv(BASE))).toBe("mock");
    expect(getCalendarDriver(parseServerEnv({ ...BASE, NODE_ENV: "production" }))).toBe("unavailable");
  });

  it("uses an explicit value, case-insensitively", () => {
    expect(getCalendarDriver(parseServerEnv({ ...BASE, CALENDAR_DRIVER: " Google " }))).toBe("google");
  });

  it("refuses the mock calendar in production", () => {
    expect(() => parseServerEnv({ ...BASE, NODE_ENV: "production", CALENDAR_DRIVER: "mock" })).toThrow(/CALENDAR_DRIVER must not be mock in production/);
  });

  it("rejects an unknown driver", () => {
    expect(() => parseServerEnv({ ...BASE, CALENDAR_DRIVER: "outlook" })).toThrow(/CALENDAR_DRIVER/);
  });

  it("auto-detects google when CALENDAR_DRIVER is unset and all three GOOGLE_* variables are present, in and outside production", () => {
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
  it("needs all three Google variables, non-blank", () => {
    expect(isGoogleCalendarConfigured(parseServerEnv({ ...BASE, ...GOOGLE }))).toBe(true);
    expect(isGoogleCalendarConfigured(parseServerEnv({ ...BASE, GOOGLE_CLIENT_ID: GOOGLE.GOOGLE_CLIENT_ID }))).toBe(false);
    expect(isGoogleCalendarConfigured(parseServerEnv({ ...BASE, ...GOOGLE, GOOGLE_TOKEN_ENCRYPTION_KEY: "   " }))).toBe(false);
    expect(isGoogleCalendarConfigured(parseServerEnv(BASE))).toBe(false);
  });
});

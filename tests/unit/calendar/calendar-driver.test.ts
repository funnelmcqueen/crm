import { describe, expect, it } from "vitest";
import { getCalendarDriver, parseServerEnv } from "@/server/env";

const BASE = {
  NODE_ENV: "development",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321/",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
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
});

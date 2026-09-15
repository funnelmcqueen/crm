import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDialerDriver,
  getPublicSupabaseEnv,
  getServerEnv,
  isTwilioConfigured,
  parsePublicSupabaseEnv,
  parseServerEnv,
  resetEnvCacheForTests,
} from "@/server/env";

const BASE = {
  NODE_ENV: "development",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321/",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
};

const TWILIO = {
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "twilio-auth-token-secret",
  TWILIO_API_KEY_SID: "SKtest",
  TWILIO_API_KEY_SECRET: "twilio-api-key-secret",
  TWILIO_TWIML_APP_SID: "APtest",
  APP_BASE_URL: "https://crm.example.com/",
};

const ALL_KEYS = [
  ...Object.keys(BASE),
  ...Object.keys(TWILIO),
  "DIALER_DRIVER",
] as const;

function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`expected an Error, got ${String(err)}`);
  }
  throw new Error("expected the call to throw");
}

describe("parseServerEnv", () => {
  it("parses the minimal Supabase configuration", () => {
    const env = parseServerEnv(BASE);
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect(env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("anon-key-value");
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe("service-role-secret-value");
    expect(env.DIALER_DRIVER).toBeUndefined();
    expect(env.APP_BASE_URL).toBeUndefined();
  });

  it("names invalid variables without echoing any values", () => {
    const err = thrownBy(() =>
      parseServerEnv({ ...BASE, SUPABASE_SERVICE_ROLE_KEY: undefined, NEXT_PUBLIC_SUPABASE_URL: "not a url" }),
    );
    expect(err.message).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(err.message).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(err.message).not.toContain("not a url");
    expect(err.message).not.toContain("anon-key-value");
  });

  it("treats blank values as unset", () => {
    const env = parseServerEnv({ ...BASE, ...TWILIO, TWILIO_AUTH_TOKEN: "   ", DIALER_DRIVER: "" });
    expect(env.TWILIO_AUTH_TOKEN).toBeUndefined();
    expect(env.DIALER_DRIVER).toBeUndefined();
    expect(isTwilioConfigured(env)).toBe(false);
    expect(thrownBy(() => parseServerEnv({ ...BASE, SUPABASE_SERVICE_ROLE_KEY: "" })).message).toContain(
      "SUPABASE_SERVICE_ROLE_KEY",
    );
  });

  it("requires every Twilio variable and APP_BASE_URL when DIALER_DRIVER=twilio", () => {
    const err = thrownBy(() =>
      parseServerEnv({
        ...BASE,
        DIALER_DRIVER: "twilio",
        TWILIO_ACCOUNT_SID: "ACtest",
        TWILIO_AUTH_TOKEN: "twilio-auth-token-secret",
      }),
    );
    for (const key of ["TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_TWIML_APP_SID", "APP_BASE_URL"]) {
      expect(err.message).toContain(key);
    }
    expect(err.message).not.toContain("TWILIO_AUTH_TOKEN");
    expect(err.message).not.toContain("twilio-auth-token-secret");
    expect(parseServerEnv({ ...BASE, ...TWILIO, DIALER_DRIVER: "twilio" }).DIALER_DRIVER).toBe("twilio");
  });

  it("rejects unknown dialer drivers and ignores letter case", () => {
    expect(() => parseServerEnv({ ...BASE, DIALER_DRIVER: "pigeon" })).toThrow(/DIALER_DRIVER/);
    expect(parseServerEnv({ ...BASE, DIALER_DRIVER: " MOCK " }).DIALER_DRIVER).toBe("mock");
  });

  it("normalizes APP_BASE_URL to an origin and rejects anything else", () => {
    expect(parseServerEnv({ ...BASE, APP_BASE_URL: "https://crm.example.com/" }).APP_BASE_URL).toBe(
      "https://crm.example.com",
    );
    expect(parseServerEnv({ ...BASE, APP_BASE_URL: "http://localhost:3000" }).APP_BASE_URL).toBe("http://localhost:3000");
    expect(() => parseServerEnv({ ...BASE, APP_BASE_URL: "https://crm.example.com/app" })).toThrow(/APP_BASE_URL/);
    expect(() => parseServerEnv({ ...BASE, APP_BASE_URL: "https://crm.example.com?x=1" })).toThrow(/APP_BASE_URL/);
    expect(() => parseServerEnv({ ...BASE, APP_BASE_URL: "ftp://crm.example.com" })).toThrow(/APP_BASE_URL/);
  });

  it("falls back to development for an unknown NODE_ENV", () => {
    expect(parseServerEnv({ ...BASE, NODE_ENV: "staging" }).NODE_ENV).toBe("development");
  });
});

describe("parsePublicSupabaseEnv", () => {
  it("needs only the public pair", () => {
    expect(
      parsePublicSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co/", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" }),
    ).toEqual({ url: "https://abc.supabase.co", anonKey: "anon" });
    expect(() => parsePublicSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" })).toThrow(
      /NEXT_PUBLIC_SUPABASE_ANON_KEY/,
    );
  });
});

describe("isTwilioConfigured", () => {
  it("needs all five Twilio variables and APP_BASE_URL", () => {
    expect(isTwilioConfigured(parseServerEnv({ ...BASE, ...TWILIO }))).toBe(true);
    expect(isTwilioConfigured(parseServerEnv({ ...BASE, ...TWILIO, APP_BASE_URL: undefined }))).toBe(false);
    expect(isTwilioConfigured(parseServerEnv({ ...BASE, ...TWILIO, TWILIO_TWIML_APP_SID: undefined }))).toBe(false);
  });
});

describe("getDialerDriver", () => {
  it("uses DIALER_DRIVER when set", () => {
    expect(getDialerDriver(parseServerEnv({ ...BASE, ...TWILIO, DIALER_DRIVER: "tel" }))).toBe("tel");
    expect(getDialerDriver(parseServerEnv({ ...BASE, NODE_ENV: "development", DIALER_DRIVER: "mock" }))).toBe("mock");
    expect(getDialerDriver(parseServerEnv({ ...BASE, NODE_ENV: "test", DIALER_DRIVER: "mock" }))).toBe("mock");
  });

  it("refuses DIALER_DRIVER=mock in production (SPEC 6: mock is for local dev and tests only)", () => {
    for (const source of [
      { ...BASE, NODE_ENV: "production", DIALER_DRIVER: "mock" },
      { ...BASE, ...TWILIO, NODE_ENV: "production", DIALER_DRIVER: " MOCK " },
    ]) {
      const err = thrownBy(() => parseServerEnv(source));
      expect(err.message).toContain("DIALER_DRIVER");
      expect(err.message).toMatch(/production/);
    }
    expect(getDialerDriver(parseServerEnv({ ...BASE, NODE_ENV: "production", DIALER_DRIVER: "tel" }))).toBe("tel");
  });

  it("defaults to twilio when Twilio is fully configured", () => {
    expect(getDialerDriver(parseServerEnv({ ...BASE, ...TWILIO }))).toBe("twilio");
  });

  it("defaults to mock outside production and tel in production", () => {
    expect(getDialerDriver(parseServerEnv({ ...BASE, NODE_ENV: "development" }))).toBe("mock");
    expect(getDialerDriver(parseServerEnv({ ...BASE, NODE_ENV: "test" }))).toBe("mock");
    expect(getDialerDriver(parseServerEnv({ ...BASE, NODE_ENV: "production" }))).toBe("tel");
  });
});

describe("process.env accessors", () => {
  function stubEnv(values: Record<string, string | undefined>) {
    for (const key of ALL_KEYS) vi.stubEnv(key, undefined);
    for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
    resetEnvCacheForTests();
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCacheForTests();
  });

  it("importing the module never throws, even with no configuration", async () => {
    stubEnv({});
    vi.resetModules();
    const fresh = await import("@/server/env");
    expect(() => fresh.getServerEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("parses lazily and caches until reset", () => {
    stubEnv({ ...BASE, NODE_ENV: "test" });
    const first = getServerEnv();
    expect(getServerEnv()).toBe(first);

    vi.stubEnv("DIALER_DRIVER", "tel");
    expect(getServerEnv().DIALER_DRIVER).toBeUndefined();

    resetEnvCacheForTests();
    expect(getServerEnv().DIALER_DRIVER).toBe("tel");
    expect(getDialerDriver()).toBe("tel");
    expect(isTwilioConfigured()).toBe(false);
  });

  it("getPublicSupabaseEnv works while the rest of the server env is invalid", () => {
    stubEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      DIALER_DRIVER: "twilio",
    });
    expect(getPublicSupabaseEnv()).toEqual({ url: "https://abc.supabase.co", anonKey: "anon" });
    expect(() => getServerEnv()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe("Supabase key safety", () => {
  const jwt = (payload: Record<string, unknown>): string =>
    [{ alg: "HS256", typ: "JWT" }, payload]
      .map((part) => Buffer.from(JSON.stringify(part), "utf8").toString("base64url"))
      .concat("c2lnbmF0dXJl")
      .join(".");
  const SERVICE_JWT = jwt({ iss: "supabase-demo", role: "service_role", exp: 1983812996 });
  const ANON_JWT = jwt({ iss: "supabase-demo", role: "anon", exp: 1983812996 });

  it("rejects a service_role JWT as NEXT_PUBLIC_SUPABASE_ANON_KEY without echoing it", () => {
    for (const parse of [parsePublicSupabaseEnv, parseServerEnv]) {
      const err = thrownBy(() => parse({ ...BASE, NEXT_PUBLIC_SUPABASE_ANON_KEY: SERVICE_JWT }));
      expect(err.message).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
      expect(err.message).not.toContain(SERVICE_JWT);
    }
  });

  it("rejects a JWT whose role is not anon, and a secret (sb_secret_) key", () => {
    for (const key of [jwt({ role: "authenticated", sub: "x" }), jwt({ role: "supabase_admin" }), jwt({ iss: "no-role" }), "sb_secret_abc123"]) {
      expect(thrownBy(() => parsePublicSupabaseEnv({ ...BASE, NEXT_PUBLIC_SUPABASE_ANON_KEY: key })).message).toContain(
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      );
    }
  });

  it("accepts an anon JWT and a publishable key", () => {
    expect(parsePublicSupabaseEnv({ ...BASE, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_JWT }).anonKey).toBe(ANON_JWT);
    expect(parsePublicSupabaseEnv({ ...BASE, NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_abc123" }).anonKey).toBe("sb_publishable_abc123");
    expect(parseServerEnv({ ...BASE, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_JWT, SUPABASE_SERVICE_ROLE_KEY: SERVICE_JWT }).SUPABASE_SERVICE_ROLE_KEY).toBe(
      SERVICE_JWT,
    );
  });

  it("rejects a service role key equal to the public key", () => {
    const err = thrownBy(() => parseServerEnv({ ...BASE, SUPABASE_SERVICE_ROLE_KEY: BASE.NEXT_PUBLIC_SUPABASE_ANON_KEY }));
    expect(err.message).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(err.message).not.toContain(BASE.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  });
});

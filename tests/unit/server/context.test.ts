import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouteContext, requireActive, requireAdmin, type Profile, type RequestContext } from "@/server/context";
import { AppError } from "@/server/errors";
import { resetEnvCacheForTests } from "@/server/env";

const USER_ID = "8f7a3c52-0c2e-4f55-9d0b-6f2a7f1e0a11";

function fakeJwt(payload: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: USER_ID,
    email: "alex@funnelmcqueen.test",
    name: "Alex Rivera",
    role: "AGENT",
    active: true,
    daily_call_target: 50,
    timezone: "America/New_York",
    in_app_calling_enabled: true,
    device_seen_at: null,
    created_at: "2026-09-15T00:00:00Z",
    deleted_at: null,
    google_calendar_id: null,
    ...overrides,
  };
}

/** Minimal GoTrue + PostgREST stand-in: /auth/v1/user returns the user, /rest/v1/profiles the given rows. */
function stubSupabase(profileRows: Profile[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/auth/v1/user")) {
      return Response.json({ id: USER_ID, aud: "authenticated", role: "authenticated", email: "alex@funnelmcqueen.test" });
    }
    if (url.includes("/rest/v1/profiles")) return Response.json(profileRows);
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bearerRequest(token: string): Request {
  return new Request("http://localhost/api/voice/token", { headers: { Authorization: `Bearer ${token}` } });
}

describe("getRouteContext", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    resetEnvCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetEnvCacheForTests();
  });

  it("builds a context for an active user with a Bearer token", async () => {
    const fetchMock = stubSupabase([profile()]);
    const ctx = await getRouteContext(bearerRequest(fakeJwt({ role: "authenticated", sub: USER_ID })));
    expect(ctx?.userId).toBe(USER_ID);
    expect(ctx?.profile.role).toBe("AGENT");
    const profileCall = fetchMock.mock.calls.map(([input]) => String(input)).find((url) => url.includes("/rest/v1/profiles"));
    expect(profileCall).toContain("select=");
    expect(profileCall).not.toContain("select=*");
  });

  it("returns null when RLS hides the profile (disabled user)", async () => {
    stubSupabase([]);
    expect(await getRouteContext(bearerRequest(fakeJwt({ role: "authenticated", sub: USER_ID })))).toBeNull();
  });

  it("rejects non-user tokens such as the service role key without calling Supabase", async () => {
    const fetchMock = stubSupabase([profile({ role: "ADMIN" })]);
    expect(await getRouteContext(bearerRequest(fakeJwt({ role: "service_role" })))).toBeNull();
    expect(await getRouteContext(bearerRequest(fakeJwt({ role: "anon" })))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null without any session", async () => {
    stubSupabase([profile()]);
    expect(await getRouteContext(new Request("http://localhost/api/voice/token"))).toBeNull();
  });
});

describe("requireActive / requireAdmin", () => {
  const ctx = (overrides: Partial<Profile> = {}): RequestContext =>
    ({ supabase: {} as RequestContext["supabase"], userId: USER_ID, profile: profile(overrides) });

  function codeOf(fn: () => unknown): string | undefined {
    try {
      fn();
    } catch (err) {
      return err instanceof AppError ? err.code : "not-an-AppError";
    }
    return undefined;
  }

  it("requireActive rejects missing and inactive contexts", () => {
    expect(codeOf(() => requireActive(null))).toBe("unauthorized");
    expect(codeOf(() => requireActive(ctx({ active: false })))).toBe("unauthorized");
    expect(requireActive(ctx()).userId).toBe(USER_ID);
  });

  it("requireAdmin rejects agents with forbidden", () => {
    expect(codeOf(() => requireAdmin(null))).toBe("unauthorized");
    expect(codeOf(() => requireAdmin(ctx()))).toBe("forbidden");
    expect(codeOf(() => requireAdmin(ctx({ role: "ADMIN", active: false })))).toBe("unauthorized");
    expect(requireAdmin(ctx({ role: "ADMIN" })).profile.role).toBe("ADMIN");
  });
});

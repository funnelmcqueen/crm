import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/server/env";
import { createRequestSupabase, getJwtRole, readBearerToken } from "@/server/supabase/request";

function fakeJwt(payload: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

describe("readBearerToken", () => {
  it.each([
    ["Bearer abc.def.ghi", "abc.def.ghi"],
    ["bearer token", "token"],
    [null, null],
    ["", null],
    ["Basic dXNlcjpwYXNz", null],
    ["Bearer", null],
    ["Bearer two parts", null],
  ])("%j -> %j", (header, expected) => {
    expect(readBearerToken(header)).toBe(expected);
  });
});

describe("getJwtRole", () => {
  it("reads the (unverified) role claim", () => {
    expect(getJwtRole(fakeJwt({ role: "authenticated", sub: "user-1" }))).toBe("authenticated");
    expect(getJwtRole(fakeJwt({ role: "service_role" }))).toBe("service_role");
  });

  it("returns null for malformed tokens", () => {
    expect(getJwtRole("not-a-jwt")).toBeNull();
    expect(getJwtRole("a.b.c")).toBeNull();
    expect(getJwtRole(fakeJwt({ sub: "user-1" }))).toBeNull();
  });
});

describe("createRequestSupabase", () => {
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

  it("sends the Bearer token, not the anon key, as Authorization on data requests", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json([]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const token = fakeJwt({ role: "authenticated", sub: "user-1" });

    const { supabase, bearerToken } = createRequestSupabase(
      new Request("http://localhost/api/calls/outbound", { headers: { Authorization: `Bearer ${token}` } }),
    );
    expect(bearerToken).toBe(token);

    await supabase.from("profiles").select("id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("apikey")).toBe("anon-key");
  });

  it("uses the cookie session without a Bearer header and leaves untouched responses alone", () => {
    const { bearerToken, applyCookies } = createRequestSupabase(
      new Request("http://localhost/api/leads/export", { headers: { cookie: "theme=dark" } }),
    );
    expect(bearerToken).toBeNull();
    const res = new Response("ok");
    expect(applyCookies(res)).toBe(res);
  });
});

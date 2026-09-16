// The Supabase session cookie carries both the access token and the refresh token. @supabase/ssr never
// sets `Secure` (DEFAULT_COOKIE_OPTIONS is path/sameSite/httpOnly/maxAge only), so without an explicit
// cookieOptions the browser attaches the session to any plaintext http:// request for the domain — a
// stray link, a non-preloaded subdomain, an attacker forcing http on first contact — handing over a
// refresh token that outlives the access token. httpOnly:false is inherent to @supabase/ssr (the
// browser client has to read the cookie); Secure is free.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serializeCookieHeader } from "@supabase/ssr";
import { describe, expect, it } from "vitest";
import { sessionCookieOptions } from "@/lib/supabase/cookie-options";

const source = (relative: string): string => readFileSync(fileURLToPath(new URL(`../../../src/${relative}`, import.meta.url)), "utf8");

/** Every place a Supabase client is created with a cookie adapter. */
const CLIENT_FILES = [
  "server/supabase/server.ts",
  "server/supabase/request.ts",
  "proxy.ts",
  "lib/supabase/browser.ts",
] as const;

describe("sessionCookieOptions", () => {
  it("marks the session cookie Secure in production only", () => {
    expect(sessionCookieOptions("production")).toMatchObject({ secure: true });
    expect(sessionCookieOptions("development")).toMatchObject({ secure: false });
    expect(sessionCookieOptions("test")).toMatchObject({ secure: false });
    // http://localhost is how this project is developed and how the e2e suite runs.
    expect(sessionCookieOptions(undefined)).toMatchObject({ secure: false });
  });

  it("produces a Set-Cookie with the Secure attribute", () => {
    const header = serializeCookieHeader("sb-127-auth-token", "base64-session-value", {
      path: "/",
      sameSite: "lax",
      ...sessionCookieOptions("production"),
    });
    expect(header).toMatch(/;\s*Secure/i);
    expect(serializeCookieHeader("sb-127-auth-token", "v", { path: "/", ...sessionCookieOptions("development") })).not.toMatch(
      /;\s*Secure/i,
    );
  });
});

describe("every Supabase client applies the session cookie options", () => {
  it.each(CLIENT_FILES)("%s passes cookieOptions", (file) => {
    const text = source(file);
    expect(text, `${file} creates a Supabase client without cookieOptions, so the session cookie has no Secure flag`).toContain(
      "cookieOptions",
    );
    expect(text).toContain("sessionCookieOptions");
  });
});

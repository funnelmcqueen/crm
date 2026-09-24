import { describe, expect, it } from "vitest";
import { isAdminPath, isPublicPath, safeNextPath } from "@/lib/supabase/auth-redirect";

describe("safeNextPath", () => {
  it.each([
    ["/leads", "/leads"],
    ["/leads?status=NEW&page=2", "/leads?status=NEW&page=2"],
    ["/leads/7b1c#history", "/leads/7b1c#history"],
    ["/admin/agents", "/admin/agents"],
  ])("keeps the same-origin path %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    ["not a string", 42],
    ["undefined", undefined],
    ["empty", ""],
    ["relative", "leads"],
    ["protocol-relative", "//evil.example/leads"],
    ["backslash host", "/\\evil.example"],
    ["absolute URL", "https://evil.example/leads"],
    ["javascript URL", "javascript:alert(1)"],
    ["dot segments into protocol-relative", "/..//evil.example"],
    ["header injection", "/leads\r\nLocation: https://evil.example"],
    ["tab", "/\tevil"],
    ["login loop", "/login?next=/leads"],
    ["auth callback", "/auth/confirm?token_hash=abc"],
    ["oversized", `/${"a".repeat(3000)}`],
  ])("falls back for %s", (_label, input) => {
    expect(safeNextPath(input)).toBe("/dashboard");
  });

  it("uses the provided fallback", () => {
    expect(safeNextPath("//evil.example", "/settings")).toBe("/settings");
  });
});

describe("path helpers", () => {
  it("recognizes public paths", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/auth/confirm")).toBe(true);
    expect(isPublicPath("/loginx")).toBe(false);
    expect(isPublicPath("/dashboard")).toBe(false);
    expect(isPublicPath("/authors")).toBe(false);
  });

  it("keeps the legal pages public, which Google's consent-screen review depends on", () => {
    // Google fetches both while signed out before it will publish the OAuth consent screen; putting either
    // behind the login would block publishing, and the connection would silently expire every seven days.
    expect(isPublicPath("/privacy")).toBe(true);
    expect(isPublicPath("/terms")).toBe(true);
    expect(isPublicPath("/privacy/extra")).toBe(false);
    expect(isPublicPath("/terminal")).toBe(false);
  });

  it("recognizes admin paths", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/phone-numbers")).toBe(true);
    expect(isAdminPath("/administrator")).toBe(false);
    expect(isAdminPath("/leads")).toBe(false);
  });
});

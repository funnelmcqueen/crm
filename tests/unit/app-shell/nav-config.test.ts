import { describe, expect, it } from "vitest";
import { getNavItems, isNavItemActive } from "@/components/app-shell/nav-config";

describe("Calls navigation", () => {
  it("shows Calls to every authenticated role", () => {
    for (const role of ["AGENT", "ADMIN"] as const) {
      expect(getNavItems(role)).toContainEqual(expect.objectContaining({ key: "calls", label: "Calls", href: "/calls" }));
    }
  });

  it("keeps Calls active on its child routes", () => {
    const calls = getNavItems("AGENT").find((item) => item.key === "calls");
    expect(calls).toBeDefined();
    expect(isNavItemActive("/calls", calls!)).toBe(true);
    expect(isNavItemActive("/calls/recording/CA123", calls!)).toBe(true);
    expect(isNavItemActive("/leads", calls!)).toBe(false);
  });
});

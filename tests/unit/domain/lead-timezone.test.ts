import { describe, expect, it } from "vitest";
import { leadTimeZone } from "@/lib/domain/lead-timezone";

const FALLBACK = "America/Los_Angeles";

describe("leadTimeZone", () => {
  it.each([
    [{ state: "FL", country: "US" }, "America/New_York"],
    [{ state: "Texas", country: "United States" }, "America/Chicago"],
    [{ state: "ca", country: "U.S.A." }, "America/Los_Angeles"],
    [{ state: "AZ", country: null }, "America/Phoenix"],
    [{ state: "new york", country: "" }, "America/New_York"],
  ])("maps %o to %s", (lead, zone) => {
    expect(leadTimeZone(lead, FALLBACK)).toEqual({ timeZone: zone, isGuess: false });
  });

  it.each([
    { state: "ON", country: "Canada" },
    { state: "ZZ", country: "US" },
    { state: null, country: "US" },
  ])("falls back to the agent's zone as a guess for %o", (lead) => {
    expect(leadTimeZone(lead, FALLBACK)).toEqual({ timeZone: FALLBACK, isGuess: true });
  });
});

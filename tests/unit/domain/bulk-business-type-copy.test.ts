import { describe, expect, it } from "vitest";
import { describeBusinessTypeResult } from "@/lib/domain/bulk-leads";

describe("describeBusinessTypeResult", () => {
  it("names the type and the count", () => {
    expect(describeBusinessTypeResult({ requested: 3, count: 3 }, "restaurant")).toBe("Set the business type to Restaurant on 3 leads.");
  });

  it("describes clearing as going back to guessing", () => {
    expect(describeBusinessTypeResult({ requested: 1, count: 1 }, null)).toBe("Cleared the business type on 1 lead, so its name decides again.");
  });

  it("says when nothing changed", () => {
    expect(describeBusinessTypeResult({ requested: 2, count: 0 }, "auto")).toBe("No business types changed.");
  });
});

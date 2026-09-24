import { describe, expect, it } from "vitest";
import { formatDate, formatNumber } from "@/lib/i18n/format";

describe("locale formatting", () => {
  it("formats numbers with the requested locale", () => {
    expect(formatNumber(1234.5, "de")).toBe("1.234,5");
    expect(formatNumber(1234.5, "en")).toBe("1,234.5");
  });

  it("formats dates with the requested locale", () => {
    const date = new Date("2024-03-05T12:00:00.000Z");
    expect(formatDate(date, "de")).toBe("05.03.24");
    expect(formatDate(date, "en")).toBe("3/5/24");
  });
});

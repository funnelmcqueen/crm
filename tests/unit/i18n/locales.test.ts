import { describe, expect, it } from "vitest";
import { resolveLocale, isLocale, type Locale } from "@/lib/i18n/locales";

describe("locale resolution", () => {
  it("accepts only English and German locale codes", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("de")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it("prefers a valid cookie, then the assigned profile locale, then English", () => {
    expect(resolveLocale("de", "en")).toBe("de");
    expect(resolveLocale("fr", "de")).toBe("de");
    expect(resolveLocale(undefined, "fr" as Locale)).toBe("en");
  });
});

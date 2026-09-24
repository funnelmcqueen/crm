import { describe, expect, it } from "vitest";
import { LANGUAGE_CHOICES } from "@/components/i18n/language-switcher";

describe("language switcher choices", () => {
  it("offers English, Deutsch, and the assigned language option", () => {
    expect(LANGUAGE_CHOICES).toEqual([
      { label: "English", value: "en" },
      { label: "Deutsch", value: "de" },
      { label: "Use assigned language", value: null },
    ]);
  });
});

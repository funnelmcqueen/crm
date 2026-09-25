import { describe, expect, it } from "vitest";
import { getAppErrorMessage } from "@/lib/i18n/app-error-message";

describe("localized app error messages", () => {
  it("maps standard errors to German messages instead of server English text", () => {
    expect(getAppErrorMessage("unauthorized", "de", "Please sign in again.")).toBe("Bitte melde dich erneut an.");
  });

  it("preserves an English server message and uses a safe fallback for unknown codes", () => {
    expect(getAppErrorMessage("validation", "en", "Choose an active agent.")).toBe("Choose an active agent.");
    expect(getAppErrorMessage("unknown", "de", "Database error 42")).toBe("Es ist ein Fehler aufgetreten. Bitte versuche es erneut.");
  });
});

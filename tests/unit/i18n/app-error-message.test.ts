import { describe, expect, it } from "vitest";
import { getAppErrorMessage, getCreateAgentWarningMessage } from "@/lib/i18n/app-error-message";

describe("localized app error messages", () => {
  it("localizes stable agent creation warning codes", () => {
    expect(getCreateAgentWarningMessage("calendar_not_connected", "de")).toBe(
      "Das Konto wurde erstellt, aber Google Kalender ist nicht verbunden. Der Agent kann noch keine Termine buchen.",
    );
  });

  it("maps standard errors to German messages instead of server English text", () => {
    expect(getAppErrorMessage("unauthorized", "de", "Please sign in again.")).toBe("Bitte melde dich erneut an.");
  });

  it("localizes rate limits and preserves the English default or supplied message", () => {
    expect(getAppErrorMessage("rate_limited", "de", "Too many requests. Try again in a moment.")).toBe(
      "Zu viele Anfragen. Bitte versuche es gleich noch einmal.",
    );
    expect(getAppErrorMessage("rate_limited", "en")).toBe("Too many requests. Try again in a moment.");
    expect(getAppErrorMessage("rate_limited", "en", "Too many exports. Try again shortly.")).toBe(
      "Too many exports. Try again shortly.",
    );
  });

  it("preserves an English server message and uses a safe fallback for unknown codes", () => {
    expect(getAppErrorMessage("validation", "en", "Choose an active agent.")).toBe("Choose an active agent.");
    expect(getAppErrorMessage("unknown", "de", "Database error 42")).toBe("Es ist ein Fehler aufgetreten. Bitte versuche es erneut.");
  });
});

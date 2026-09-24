import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { IncomingCallBody } from "@/components/dialer/incoming-call-dialog";
import { LeadStatusSelect } from "@/components/leads/lead-status-select";
import { ManualCallbackButton } from "@/components/calls/manual-callback-button";
import { Dialog } from "@/components/ui/dialog";
import { ManualKeypadControls } from "@/components/dialer/persistent-keypad";
import { CallHistoryFilters } from "@/components/calls/call-history-filters";
import { DateTime } from "@/components/common/datetime";

function german(element: React.ReactElement) {
  return renderToStaticMarkup(<LocaleProvider locale="de">{element}</LocaleProvider>);
}

describe("German sales workspace", () => {
  it("labels incoming calls and actions in German without exposing an unknown lead", () => {
    const html = german(createElement(Dialog, { open: true }, createElement(IncomingCallBody, {
      context: { status: "unknown" }, onAccept() {}, onDecline() {},
    })));
    expect(html).toContain("Eingehender Anruf");
    expect(html).toContain("Unbekannter Anrufer");
    expect(html).toContain("Annehmen");
    expect(html).toContain("Ablehnen");
  });

  it("labels a callback action in German and keeps its phone number", () => {
    const html = german(createElement(ManualCallbackButton, { phone: "+19415550124" }));
    expect(html).toContain("Rückruf");
    expect(html).toContain('aria-label="(941) 555-0124 zurückrufen"');
    expect(html).toContain("min-h-12");
  });

  it("shows localized lead status and a 48px status choice", () => {
    const html = german(createElement(LeadStatusSelect, { leadId: "lead-1", status: "NEW", isAdmin: false }));
    expect(html).toContain("Neu");
    expect(html).toContain("min-h-12");
  });

  it("labels the persistent keypad controls in German", () => {
    const html = german(createElement(Dialog, { open: true }, createElement(ManualKeypadControls, {
      value: "", busy: false, error: "", onValueChange() {}, onCall() {}, onClose() {},
    })));
    expect(html).toContain("Nummer eingeben");
    expect(html).toContain('aria-label="Tastenfeld schließen"');
    expect(html).toContain('aria-label="Nummer anrufen"');
    expect(html).toContain("min-h-12");
  });

  it("shows German call history tabs and keeps call filter URLs", () => {
    const html = german(createElement(CallHistoryFilters, { tab: "missed", isAdmin: false, agents: [] }));
    expect(html).toContain("Verpasst");
    expect(html).toContain('href="/calls?tab=missed"');
    expect(html).toContain('aria-current="page"');
  });

  it("formats a scheduled follow-up with German date and time conventions", () => {
    const html = renderToStaticMarkup(createElement(DateTime, {
      value: "2026-09-25T13:30:00.000Z", tz: "Europe/Berlin", style: "datetime", locale: "de",
    }));
    expect(html).toContain("25.09.2026");
    expect(html).toContain("15:30");
  });
});

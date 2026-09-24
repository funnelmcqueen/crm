import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { CallHistoryList } from "@/components/calls/call-history-list";
import { CallHistory } from "@/components/leads/call-history";
import { LeadsPagination } from "@/components/leads/leads-pagination";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CallHistoryRow } from "@/server/services/calls";
import type { CallHistoryEntry } from "@/server/services/leads";

function german(element: React.ReactElement) {
  return renderToStaticMarkup(<LocaleProvider locale="de"><TooltipProvider>{element}</TooltipProvider></LocaleProvider>);
}

describe("German lead and call lists", () => {
  it("localizes lead pagination and count separators while preserving links", () => {
    const html = german(createElement(LeadsPagination, {
      params: { q: "", statuses: [], source: null, agent: null, unassigned: false, sort: "created_at", dir: "desc", page: 2 },
      window: { page: 2, pageCount: 3, total: 1234, from: 51, to: 100, pageSize: 50 },
    }));
    expect(html).toContain('aria-label="Seitennavigation"');
    expect(html).toContain("1.234");
    expect(html).toContain("Zurück");
    expect(html).toContain("Weiter");
    expect(html).toContain('rel="prev"');
  });

  it("localizes the Calls list and German local time without changing lead links or phone data", () => {
    const row: CallHistoryRow = {
      id: "call-1", createdAt: "2026-09-25T13:30:00.000Z", leadId: "lead-1", leadStatus: "NEW",
      businessName: "Palm Table", contactName: "Ava", remoteE164: "+19415550123", userId: "agent-1", agentName: "Maya",
      direction: "INBOUND", outcome: null, callStatus: "no-answer", durationSeconds: 42,
      hasVoicemail: false, voicemailDurationSeconds: null, handledAt: null,
    };
    const html = german(createElement(CallHistoryList, { rows: [row], tz: "Europe/Berlin", now: Date.parse("2026-09-25T14:00:00Z"), isAdmin: true }));
    expect(html).toContain("Richtung");
    expect(html).toContain("Eingehend");
    expect(html).toContain("Nicht erreicht");
    expect(html).toContain("15:30");
    expect(html).toContain('href="/leads/lead-1"');
    expect(html).toContain("(941) 555-0123");
  });

  it("localizes the lead call history empty state", () => {
    const html = german(createElement(CallHistory, { history: [] as CallHistoryEntry[], tz: "Europe/Berlin", now: 0, isAdmin: false, canMarkHeard: true }));
    expect(html).toContain("Noch keine Anrufe");
  });
});

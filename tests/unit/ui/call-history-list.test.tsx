import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CallHistoryFilters } from "@/components/calls/call-history-filters";
import { CallHistoryList } from "@/components/calls/call-history-list";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CallHistoryRow } from "@/server/services/calls";

const row: CallHistoryRow = {
  id: "call-1", createdAt: "2026-09-23T13:00:00.000Z", leadId: "lead-1", leadStatus: "NEW", businessName: "Palm Table", contactName: "Ava", remoteE164: "+19415550123", userId: "agent-1", agentName: "Maya", direction: "INBOUND", outcome: null, callStatus: "no-answer", durationSeconds: 42, hasVoicemail: false, voicemailDurationSeconds: null, handledAt: null,
};

describe("calls workspace UI", () => {
  it("renders URL tabs and exposes the agent filter only to admins", () => {
    const agent = renderToStaticMarkup(createElement(CallHistoryFilters, { tab: "all", isAdmin: false, agents: [], selectedAgentId: undefined }));
    const admin = renderToStaticMarkup(createElement(CallHistoryFilters, { tab: "missed", isAdmin: true, agents: [{ id: "agent-1", name: "Maya" }], selectedAgentId: "agent-1" }));
    for (const label of ["All", "Missed", "Voicemail"]) expect(agent).toContain(label);
    expect(agent).not.toContain("Filter by agent");
    expect(admin).toContain("Filter by agent");
    expect(admin).toContain('value="agent-1" selected=""');
    expect(admin).toContain("min-h-12");
  });

  it("links known callers, keeps unknown callers unlinked, and has mobile-sized callback controls", () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(CallHistoryList, {
      rows: [row, { ...row, id: "call-2", leadId: null, leadStatus: null, businessName: null, contactName: null, remoteE164: "+19415550124" }],
      tz: "America/New_York", now: Date.parse("2026-09-23T15:00:00.000Z"), isAdmin: true,
    })));
    expect(html).toContain('href="/leads/lead-1"');
    expect(html).toContain("Palm Table");
    expect(html).toContain("Unknown caller");
    expect(html).toContain("Call back");
    expect(html).toContain("min-h-12");
    expect(html).toContain("hidden overflow-x-auto");
    expect(html).toContain("xl:hidden");
  });
});
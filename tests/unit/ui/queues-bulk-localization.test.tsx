import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { FollowUpTabs } from "@/components/follow-ups/follow-up-tabs";
import { CompleteButton } from "@/components/follow-ups/follow-up-actions";
import { NextLeadLink } from "@/components/dialer/next-lead-link";
import { LeadSelectionProvider } from "@/components/leads/bulk/selection-context";
import { UnassignedCallout } from "@/components/leads/bulk/unassigned-callout";
import type { MatchingLeadFilters } from "@/server/services/bulk-leads";
import { SkippedLeadList } from "@/components/follow-ups/skipped-list";
import en from "@/lib/i18n/messages/en/workspace";
import de from "@/lib/i18n/messages/de/workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {} }) }));

function german(element: React.ReactElement) {
  return renderToStaticMarkup(<LocaleProvider locale="de">{element}</LocaleProvider>);
}

describe("German queue navigation and actions", () => {
  it("provides translated bulk progress and export feedback", () => {
    const english = en.bulkUi as Record<string, string>;
    const german = de.bulkUi as Record<string, string>;
    expect(german.assigning).toBe("Weise {count} Leads {agent} zu…");
    expect(german.moving).toBe("Verschiebe {count} Leads nach {status}…");
    expect(german.exported).toBe("{count} Leads exportiert.");
    expect(english.assigning).toBe("Assigning {count} to {agent}…");
  });

  it("announces the voicemail queue and unread count in German", () => {
    const html = german(<FollowUpTabs active="voicemails" counts={{ overdue: 1, today: 2, upcoming: 3, completed: 4, voicemailsTotal: 5, voicemailsUnheard: 2, skipped: 6 }} />);
    expect(html).toContain('aria-label="Wiedervorlagen"');
    expect(html).toContain("Sprachnachrichten");
    expect(html).toContain("2 ungehört");
    expect(html).toContain('href="/follow-ups?tab=voicemails"');
  });

  it("gives the follow-up completion button a German accessible name", () => {
    const html = german(<CompleteButton businessName="Cafe Alba" onComplete={() => {}} />);
    expect(html).toContain('aria-label="Wiedervorlage für Cafe Alba abschließen"');
    expect(html).toContain("Abschließen");
    expect(html).toContain("h-12");
  });

  it("labels the next lead entry in German", () => {
    const html = german(<NextLeadLink />);
    expect(html).toContain('aria-label="Nächster Lead"');
    expect(html).toContain('href="/next"');
  });

  it("shows the unassigned bulk entry in German while retaining its destination", () => {
    const html = german(<LeadSelectionProvider scope="test" pageIds={[]} total={0} filters={{} as MatchingLeadFilters} isAdmin>
      <UnassignedCallout unassigned={3} showingUnassigned={false} unassignedHref="/leads?agent=unassigned" />
    </LeadSelectionProvider>);
    expect(html).toContain('aria-label="Nicht zugewiesene Leads"');
    expect(html).toContain("Nicht zugewiesene prüfen");
    expect(html).toContain('href="/leads?agent=unassigned"');
  });

  it("shows skipped queue actions and reason in German", () => {
    const html = german(<SkippedLeadList rows={[{
      skipId: "skip-1", leadId: "lead-1", businessName: "Cafe Alba", contactName: null,
      phone: "+19415550124", leadStatus: "NEW", reason: "NEEDS_RESEARCH", note: null,
      skippedAt: "2026-09-24T10:00:00.000Z", nextFollowUpAt: null, assignedTo: null, ownerName: null,
    }]} tz="Europe/Berlin" now={Date.parse("2026-09-24T12:00:00.000Z")} isAdmin={false} agents={[]} empty={null} />);
    expect(html).toContain("Recherche erforderlich");
    expect(html).toContain("Anrufe fortsetzen");
    expect(html).toContain("Übersprungen");
    expect(html).toContain("h-12");
  });
});

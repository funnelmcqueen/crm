import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { FollowUpTabs } from "@/components/follow-ups/follow-up-tabs";
import { CompleteButton } from "@/components/follow-ups/follow-up-actions";
import { NextLeadLink } from "@/components/dialer/next-lead-link";
import { LeadSelectionProvider } from "@/components/leads/bulk/selection-context";
import { UnassignedCallout } from "@/components/leads/bulk/unassigned-callout";
import type { MatchingLeadFilters } from "@/server/services/bulk-leads";

function german(element: React.ReactElement) {
  return renderToStaticMarkup(<LocaleProvider locale="de">{element}</LocaleProvider>);
}

describe("German queue navigation and actions", () => {
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
});

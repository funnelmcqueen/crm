import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { TargetBar } from "@/components/dashboard/target-bar";
import { PipelineToolbar } from "@/components/pipeline/pipeline-toolbar";
import { BookingPanel } from "@/components/booking/booking-panel";
import { NameForm } from "@/components/settings/profile-forms";
import { dailyGoal } from "@/lib/domain/daily-goal";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {} }) }));
vi.mock("@/components/dialer/dialer-context", () => ({ useDialer: () => ({}) }));

const german = (element: React.ReactElement) => renderToStaticMarkup(<LocaleProvider locale="de">{element}</LocaleProvider>);

describe("German operational screens", () => {
  it("announces goal progress and formats its numbers in German", () => {
    const html = german(<TargetBar goal={dailyGoal(1200, 1500)} label="Anrufe heute" />);
    expect(html).toContain('aria-label="Anrufe heute"');
    expect(html).toContain("1.200 von 1.500 Anrufen");
  });

  it("translates pipeline filters while retaining 48px controls", () => {
    const html = german(<PipelineToolbar params={{ closed: false, agent: null, unassigned: false }} isAdmin agents={[]} />);
    expect(html).toContain('aria-label="Nach Agent filtern"');
    expect(html).toContain("Geschlossene anzeigen");
    expect(html).toContain("h-12");
  });

  it("translates the calendar loading state", () => {
    const html = german(<BookingPanel leadId="lead-1" state={{ kind: "loading" }} onReload={() => {}} onBooked={() => {}} />);
    expect(html).toContain("Kalender wird geladen");
  });

  it("translates profile form controls and retains the entered name", () => {
    const html = german(<NameForm name="Cafe Alba" />);
    expect(html).toContain("Name");
    expect(html).toContain("Speichern");
    expect(html).toContain('value="Cafe Alba"');
    expect(html).toContain("h-12");
  });
});

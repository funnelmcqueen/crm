import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { CreateAgentDialog } from "@/components/admin/agents/agent-dialogs";
import { AgentsTable } from "@/components/admin/agents/agents-list";
import { PhoneNumbersList } from "@/components/admin/phone-numbers/phone-numbers-list";
import { ReportRangePicker } from "@/components/admin/reports/report-range-picker";
import { ImportWizard } from "@/components/import/import-wizard";
import { AssignStep } from "@/components/import/assign-step";
import { getImportValidationMessage } from "@/components/import/import-validation-message";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));

const german = (element: React.ReactElement) => renderToStaticMarkup(<LocaleProvider locale="de">{element}</LocaleProvider>);

describe("German admin tools", () => {
  it("translates the agent creation trigger and retains its touch size", () => {
    const html = german(<CreateAgentDialog defaultTarget={50} defaultTimezone="Europe/Berlin" />);
    expect(html).toContain("Agent erstellen");
    expect(html).toContain("h-12");
  });

  it("translates agent and number table headings", () => {
    expect(german(<AgentsTable agents={[]} reassignTargets={[]} />)).toContain("Anrufe heute");
    expect(german(<PhoneNumbersList rows={[]} agents={[]} tz="Europe/Berlin" now={0} />)).toContain("Zugewiesen an");
  });

  it("translates report range controls and keeps their dates and touch size", () => {
    const html = german(<ReportRangePicker range={{ from: "2026-09-01", to: "2026-09-25" }} preset={null} presets={[]} problem={null} timezone="Europe/Berlin" />);
    expect(html).toContain('aria-label="Datumsbereich"');
    expect(html).toContain("2026-09-01");
    expect(html).toContain("h-12");
  });

  it("translates the import upload and assignment choices", () => {
    expect(german(<ImportWizard />)).toContain("CSV-Datei auswählen");
    const html = german(<AssignStep total={3} assignment={{ mode: "unassigned" }} onAssignmentChange={() => {}} />);
    expect(html).toContain("Nicht zuweisen");
    expect(html).toContain("min-h-12");
  });

  it("translates CSV validation while preserving measured limits", () => {
    expect(getImportValidationMessage("This file has 12 columns. The limit is 100.", "de")).toBe("Die Datei hat 12 Spalten. Erlaubt sind höchstens 100.");
    expect(getImportValidationMessage("Choose a .csv file.", "de")).toBe("Wähle eine .csv-Datei.");
  });
});

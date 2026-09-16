import type { Metadata } from "next";
import {
  REPORT_PRESETS,
  REPORT_PRESET_LABELS,
  RANGE_PROBLEM_MESSAGES,
  formatRangeLabel,
  parseReportRangeParams,
  presetRange,
  reportRangeHref,
} from "@/components/admin/reports/date-range";
import { ReportRangePicker } from "@/components/admin/reports/report-range-picker";
import { AgentReport, NumberReport, TeamTotals } from "@/components/admin/reports/report-sections";
import { currentTime } from "@/components/common/datetime";
import { PageHeader } from "@/components/common/page-header";
import { requireAdminPage } from "@/server/context";
import { getReport } from "@/server/services/reports";

export const metadata: Metadata = {
  title: "Reports",
};

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminPage();
  const tz = ctx.profile.timezone;
  const now = currentTime();
  const parsed = parseReportRangeParams(await searchParams, tz, now);
  const report = await getReport(ctx, parsed.range);

  const presets = REPORT_PRESETS.map((preset) => ({
    preset,
    label: REPORT_PRESET_LABELS[preset],
    href: reportRangeHref(presetRange(preset, tz, now)),
  }));

  return (
    <>
      <PageHeader
        title="Reports"
        description={
          <>
            <span className="font-semibold text-foreground">{formatRangeLabel(report.range)}</span> ·{" "}
            <span className="tabular-nums">{report.days}</span> {report.days === 1 ? "day" : "days"}
          </>
        }
      />

      <ReportRangePicker
        range={parsed.range}
        preset={parsed.preset}
        presets={presets}
        problem={parsed.problem ? RANGE_PROBLEM_MESSAGES[parsed.problem] : null}
        timezone={tz}
      />

      <TeamTotals totals={report.totals} />
      <AgentReport rows={report.agents} />
      <NumberReport rows={report.numbers} />

      <p className="text-xs text-muted-foreground">
        Dials are outbound calls that were logged or reached Twilio. Connected counts every logged outcome except No
        Answer, Voicemail and Wrong Number, including answered callbacks. Clients are leads currently assigned with status
        Client, whatever the range.
      </p>
    </>
  );
}

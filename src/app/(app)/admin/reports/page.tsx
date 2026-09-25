import type { Metadata } from "next";
import {
  REPORT_PRESETS,
  formatRangeLabel,
  parseReportRangeParams,
  presetRange,
  reportRangeHref,
} from "@/components/admin/reports/date-range";
import { ReportRangePicker } from "@/components/admin/reports/report-range-picker";
import { AgentReport, NumberReport, TeamTotals } from "@/components/admin/reports/report-sections";
import { currentTime } from "@/components/common/datetime";
import { PageHeader } from "@/components/common/page-header";
import { getServerWorkspace } from "@/lib/i18n/server-workspace";
import adminEn from "@/lib/i18n/messages/en/admin";
import adminDe from "@/lib/i18n/messages/de/admin";
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
  const { locale } = await getServerWorkspace(ctx.profile.primary_locale);
  const t = locale === "de" ? adminDe : adminEn;
  const tz = ctx.profile.timezone;
  const now = currentTime();
  const parsed = parseReportRangeParams(await searchParams, tz, now);
  const report = await getReport(ctx, parsed.range);

  const presets = REPORT_PRESETS.map((preset) => ({
    preset,
    label: preset === "today" ? t["Today"] : preset === "yesterday" ? t["Yesterday"] : preset === "last7" ? t["Last 7 days"] : preset === "last30" ? t["Last 30 days"] : t["This month"],
    href: reportRangeHref(presetRange(preset, tz, now)),
  }));

  return (
    <>
      <PageHeader
        title={t["Reports"]}
        description={
          <>
            <span className="font-semibold text-foreground">{formatRangeLabel(report.range)}</span> ·{" "}
            <span className="tabular-nums">{report.days}</span> {report.days === 1 ? t["day"] : t["days"]}
          </>
        }
      />

      <ReportRangePicker
        range={parsed.range}
        preset={parsed.preset}
        presets={presets}
        problem={parsed.problem ? parsed.problem === "invalid_date" ? t["Enter a valid date."] : parsed.problem === "reversed" ? t["The end date must be on or after the start date."] : t["Choose a range of 366 days or less."] : null}
        timezone={tz}
      />

      <TeamTotals totals={report.totals} />
      <AgentReport rows={report.agents} />
      <NumberReport rows={report.numbers} />

      <p className="text-xs text-muted-foreground">
        {t["Dials are outbound calls that were logged or reached Twilio. Connected counts every logged outcome except No Answer, Voicemail and Wrong Number, including answered callbacks. Clients are leads currently assigned with status Client, whatever the range."]}
      </p>
    </>
  );
}

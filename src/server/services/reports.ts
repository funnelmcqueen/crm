// Admin Reports (SPEC 8): team totals, per agent, per number for an inclusive local date range in the admin's
// timezone. Aggregation happens in the admin-only SQL functions (shared stat definitions, attribution by
// calls.user_id); this service only validates the range, converts it to instants and maps the rows.
import { z } from "zod";
import {
  RANGE_PROBLEM_MESSAGES,
  localDaySpan,
  rangeToInstants,
  validateLocalRange,
  type LocalDateRange,
} from "@/components/admin/reports/date-range";
import { requireAdmin, type RequestContext } from "@/server/context";
import { AppError, mapPostgrestError, type PostgrestLikeError } from "@/server/errors";

export interface ReportTotals {
  /** Number of per-agent rows the totals sum. */
  agents: number;
  dials: number;
  connected: number;
  /** connected / dials as a fraction (0..1, may exceed 1 when answered inbound calls connect). */
  connectRate: number;
  talkSeconds: number;
  avgCallSeconds: number;
  interested: number;
  appointments: number;
  clients: number;
}

export interface AgentReportRow {
  userId: string;
  name: string;
  active: boolean;
  dials: number;
  connected: number;
  connectRate: number;
  talkSeconds: number;
  avgCallSeconds: number;
  interested: number;
  appointments: number;
  clients: number;
}

export interface NumberReportRow {
  phoneNumberId: string;
  e164: string;
  label: string | null;
  active: boolean;
  dials: number;
  answered: number;
  answerRate: number;
}

export interface ReportResult {
  range: LocalDateRange;
  days: number;
  timezone: string;
  fromIso: string;
  toIso: string;
  totals: ReportTotals;
  agents: AgentReportRow[];
  numbers: NumberReportRow[];
}

const reportInputSchema = z.object({
  from: z.string().max(20),
  to: z.string().max(20),
});

export type ReportInput = z.input<typeof reportInputSchema>;

const num = z.coerce.number().refine(Number.isFinite);

const totalsSchema = z.object({
  agents: num,
  dials: num,
  connected: num,
  connect_rate: num,
  talk_seconds: num,
  avg_call_seconds: num,
  interested: num,
  appointments: num,
  clients: num,
});

function fail(error: PostgrestLikeError): never {
  if (error.code === "22023") throw new AppError("validation", RANGE_PROBLEM_MESSAGES.invalid_date, { cause: error });
  throw mapPostgrestError(error);
}

export async function getReport(ctx: RequestContext | null, input: unknown): Promise<ReportResult> {
  const admin = requireAdmin(ctx);
  const parsed = reportInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", RANGE_PROBLEM_MESSAGES.invalid_date);
  const problem = validateLocalRange(parsed.data.from, parsed.data.to);
  if (problem) throw new AppError("validation", RANGE_PROBLEM_MESSAGES[problem]);

  const range: LocalDateRange = { from: parsed.data.from, to: parsed.data.to };
  const timezone = admin.profile.timezone;
  const { fromIso, toIso } = rangeToInstants(range, timezone);
  const args = { p_from: fromIso, p_to: toIso };

  const [agentsResult, numbersResult, totalsResult] = await Promise.all([
    admin.supabase.rpc("admin_report_agents", args),
    admin.supabase.rpc("admin_report_numbers", args),
    admin.supabase.rpc("admin_report_totals", args),
  ]);
  if (agentsResult.error) fail(agentsResult.error);
  if (numbersResult.error) fail(numbersResult.error);
  if (totalsResult.error) fail(totalsResult.error);

  const totals = totalsSchema.safeParse(totalsResult.data);
  if (!totals.success) throw new AppError("internal", undefined, { cause: totals.error });

  return {
    range,
    days: localDaySpan(range),
    timezone,
    fromIso,
    toIso,
    totals: {
      agents: totals.data.agents,
      dials: totals.data.dials,
      connected: totals.data.connected,
      connectRate: totals.data.connect_rate,
      talkSeconds: totals.data.talk_seconds,
      avgCallSeconds: totals.data.avg_call_seconds,
      interested: totals.data.interested,
      appointments: totals.data.appointments,
      clients: totals.data.clients,
    },
    agents: (agentsResult.data ?? []).map((row) => ({
      userId: row.user_id,
      name: row.name,
      active: row.active,
      dials: Number(row.dials),
      connected: Number(row.connected),
      connectRate: Number(row.connect_rate),
      talkSeconds: Number(row.talk_seconds),
      avgCallSeconds: Number(row.avg_call_seconds),
      interested: Number(row.interested),
      appointments: Number(row.appointments),
      clients: Number(row.clients),
    })),
    numbers: (numbersResult.data ?? []).map((row) => ({
      phoneNumberId: row.phone_number_id,
      e164: row.e164,
      label: row.label ?? null,
      active: row.active,
      dials: Number(row.dials),
      answered: Number(row.answered),
      answerRate: Number(row.answer_rate),
    })),
  };
}

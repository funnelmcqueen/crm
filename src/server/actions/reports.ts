"use server";

import { getActionContext } from "@/server/context";
import { runAction, type ActionResult } from "@/server/errors";
import { getReport, type ReportResult } from "@/server/services/reports";

// Thin wrapper: the service validates the range with Zod and requires an active admin. The Reports page
// reads through the service directly (the range lives in the URL); this is for client-side refetches.
export async function getReportAction(from: string, to: string): Promise<ActionResult<ReportResult>> {
  return runAction(async () => getReport(await getActionContext(), { from, to }));
}

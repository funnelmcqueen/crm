"use server";

import type { BatchAssignment, DuplicateKeySet, ExistingDuplicateLead, ImportBatch } from "@/components/import/import-model";
import { getActionContext } from "@/server/context";
import { runAction, type ActionResult } from "@/server/errors";
import {
  checkImportDuplicates,
  importLeadsBatch,
  listImportAgents,
  type ImportAgentOption,
  type ImportBatchResult,
} from "@/server/services/import";

// Thin wrappers: the services validate every argument with Zod and require an active admin.

export async function listImportAgentsAction(): Promise<ActionResult<ImportAgentOption[]>> {
  return runAction(async () => listImportAgents(await getActionContext()));
}

export async function checkImportDuplicatesAction(keys: DuplicateKeySet): Promise<ActionResult<ExistingDuplicateLead[]>> {
  return runAction(async () => checkImportDuplicates(await getActionContext(), keys));
}

export async function importLeadsBatchAction(batch: ImportBatch, assignment: BatchAssignment): Promise<ActionResult<ImportBatchResult>> {
  return runAction(async () => importLeadsBatch(await getActionContext(), batch, assignment));
}

"use server";

import { getActionContext } from "@/server/context";
import { runAction, type ActionResult } from "@/server/errors";
import {
  loadPipelineColumn,
  moveLeadToColumn,
  type PipelineColumnPage,
  type PipelineMoveResult,
} from "@/server/services/pipeline";

// Thin wrappers: the services validate every argument with Zod and check the session and role.
//
// Neither action calls refresh(). The board keeps its own optimistic state (including pages loaded with
// "Load more"), and a server re-render would reset every column back to its first page.

export interface LoadPipelineColumnInput {
  column: string;
  offset: number;
  agentId: string | null;
  unassigned: boolean;
}

export async function loadPipelineColumnAction(input: LoadPipelineColumnInput): Promise<ActionResult<PipelineColumnPage>> {
  return runAction(async () => loadPipelineColumn(await getActionContext(), input));
}

export async function moveLeadToColumnAction(leadId: string, column: string): Promise<ActionResult<PipelineMoveResult>> {
  return runAction(async () => moveLeadToColumn(await getActionContext(), leadId, column));
}

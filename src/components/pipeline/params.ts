import { z } from "zod";
import type { RawSearchParams } from "@/components/leads/list-params";

export interface PipelineParams {
  /** `?closed=1` adds the Not Interested and Do Not Contact columns. */
  closed: boolean;
  /** Admin only; the page ignores it for agents. */
  agent: string | null;
  /** Admin only; the page ignores it for agents. Wins over `agent`. */
  unassigned: boolean;
}

export const DEFAULT_PIPELINE_PARAMS: PipelineParams = { closed: false, agent: null, unassigned: false };

const uuidSchema = z.uuid();

function first(raw: RawSearchParams, key: string): string | undefined {
  if (raw instanceof URLSearchParams) return raw.get(key) ?? undefined;
  const value = raw[key];
  return Array.isArray(value) ? value[0] : value;
}

function flag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

/** Lenient: a missing or bad value falls back to its default instead of failing the page. */
export function parsePipelineParams(raw: RawSearchParams): PipelineParams {
  const unassigned = flag(first(raw, "unassigned"));
  const agent = uuidSchema.safeParse(first(raw, "agent")?.trim().toLowerCase());
  return {
    closed: flag(first(raw, "closed")),
    agent: !unassigned && agent.success ? agent.data : null,
    unassigned,
  };
}

/** Query string (without `?`) that round-trips through parsePipelineParams. Defaults are omitted. */
export function serializePipelineParams(params: PipelineParams): string {
  const search = new URLSearchParams();
  if (params.unassigned) search.set("unassigned", "1");
  else if (params.agent) search.set("agent", params.agent);
  if (params.closed) search.set("closed", "1");
  return search.toString();
}

export function pipelineHref(params: PipelineParams, pathname = "/pipeline"): string {
  const query = serializePipelineParams(params);
  return query === "" ? pathname : `${pathname}?${query}`;
}

import { z } from "zod";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/domain/statuses";

/** Sort keys accepted by the `search_leads` RPC. */
export const LEAD_SORT_KEYS = ["business_name", "last_contacted_at", "next_follow_up_at", "call_count", "created_at"] as const;
export type LeadSortKey = (typeof LEAD_SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

export const LEAD_SORT_LABELS: Readonly<Record<LeadSortKey, string>> = {
  business_name: "Business",
  last_contacted_at: "Last contacted",
  next_follow_up_at: "Next follow-up",
  call_count: "Call count",
  created_at: "Created",
};

/** The direction a sort starts in when the URL does not say: A-Z, soonest follow-up, newest/most otherwise. */
export const DEFAULT_SORT_DIR: Readonly<Record<LeadSortKey, SortDir>> = {
  business_name: "asc",
  last_contacted_at: "desc",
  next_follow_up_at: "asc",
  call_count: "desc",
  created_at: "desc",
};

export const DEFAULT_SORT: LeadSortKey = "created_at";
export const MAX_QUERY_LENGTH = 200;
export const MAX_SOURCE_LENGTH = 200;
const MAX_PAGE = 100_000;

export interface LeadListParams {
  q: string;
  statuses: LeadStatus[];
  source: string | null;
  /** Admin only; the page ignores it for agents. */
  agent: string | null;
  /** Admin only; the page ignores it for agents. */
  unassigned: boolean;
  sort: LeadSortKey;
  dir: SortDir;
  page: number;
}

export type RawSearchParams = Record<string, string | string[] | undefined> | URLSearchParams;

const sortSchema = z.enum(LEAD_SORT_KEYS);
const dirSchema = z.enum(["asc", "desc"]);
const statusSchema = z.enum(LEAD_STATUSES);
const uuidSchema = z.uuid();
const pageSchema = z.coerce.number().int().min(1).max(MAX_PAGE);

function all(raw: RawSearchParams, key: string): string[] {
  if (raw instanceof URLSearchParams) return raw.getAll(key);
  const value = raw[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function first(raw: RawSearchParams, key: string): string | undefined {
  return all(raw, key)[0];
}

function cleanText(value: string | undefined, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

/** Lenient: a missing or bad value falls back to its default instead of failing the page. */
export function parseLeadListParams(raw: RawSearchParams): LeadListParams {
  const sortResult = sortSchema.safeParse(first(raw, "sort"));
  const sort = sortResult.success ? sortResult.data : DEFAULT_SORT;
  const dirResult = dirSchema.safeParse(first(raw, "dir")?.toLowerCase());
  const dir = dirResult.success ? dirResult.data : DEFAULT_SORT_DIR[sort];

  const statuses: LeadStatus[] = [];
  for (const value of all(raw, "status")) {
    for (const part of value.split(",")) {
      const parsed = statusSchema.safeParse(part.trim().toUpperCase());
      if (parsed.success && !statuses.includes(parsed.data)) statuses.push(parsed.data);
    }
  }
  statuses.sort((a, b) => LEAD_STATUSES.indexOf(a) - LEAD_STATUSES.indexOf(b));

  const agentResult = uuidSchema.safeParse(first(raw, "agent")?.trim().toLowerCase());
  const unassignedRaw = first(raw, "unassigned")?.trim().toLowerCase();
  const pageRaw = first(raw, "page")?.trim();
  const pageResult = pageRaw && /^\d+$/.test(pageRaw) ? pageSchema.safeParse(pageRaw) : null;
  const source = cleanText(first(raw, "source"), MAX_SOURCE_LENGTH);

  return {
    q: cleanText(first(raw, "q"), MAX_QUERY_LENGTH),
    statuses,
    source: source === "" ? null : source,
    agent: agentResult.success ? agentResult.data : null,
    unassigned: unassignedRaw === "1" || unassignedRaw === "true",
    sort,
    dir,
    page: pageResult?.success ? pageResult.data : 1,
  };
}

export const DEFAULT_LEAD_LIST_PARAMS: LeadListParams = parseLeadListParams({});

/** Query string (without `?`) that round-trips through parseLeadListParams. Defaults are omitted. */
export function serializeLeadListParams(params: LeadListParams): string {
  const search = new URLSearchParams();
  if (params.q.trim() !== "") search.set("q", params.q.trim().slice(0, MAX_QUERY_LENGTH));
  if (params.statuses.length > 0) search.set("status", params.statuses.join(","));
  if (params.source) search.set("source", params.source);
  if (params.unassigned) search.set("unassigned", "1");
  else if (params.agent) search.set("agent", params.agent);
  if (params.sort !== DEFAULT_SORT) search.set("sort", params.sort);
  if (params.dir !== DEFAULT_SORT_DIR[params.sort]) search.set("dir", params.dir);
  if (params.page > 1) search.set("page", String(params.page));
  return search.toString();
}

export function leadListHref(params: LeadListParams, pathname = "/leads"): string {
  const query = serializeLeadListParams(params);
  return query === "" ? pathname : `${pathname}?${query}`;
}

/** True when search or any filter narrows the list (sort and page do not count). */
export function hasActiveFilters(params: LeadListParams): boolean {
  return params.q !== "" || params.statuses.length > 0 || params.source !== null || params.agent !== null || params.unassigned;
}

export interface PageWindow {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  /** 1-based index of the first row on this page, 0 when the page is empty. */
  from: number;
  /** 1-based index of the last row on this page, 0 when the page is empty. */
  to: number;
}

export function pageWindow(page: number, pageSize: number, total: number, rowsOnPage: number): PageWindow {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = rowsOnPage > 0 ? (page - 1) * pageSize + 1 : 0;
  const to = rowsOnPage > 0 ? from + rowsOnPage - 1 : 0;
  return { page, pageSize, total, pageCount, from, to };
}

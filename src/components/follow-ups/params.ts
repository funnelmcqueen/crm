import { z } from "zod";

/** Tabs backed by `list_follow_ups`. */
export const FOLLOW_UP_LIST_TABS = ["overdue", "today", "upcoming", "completed"] as const;
export type FollowUpListTab = (typeof FOLLOW_UP_LIST_TABS)[number];

/** Every tab on /follow-ups, in display order. Skipped is the Skipped queue (DEVIATIONS D42). */
export const FOLLOW_UP_TABS = [...FOLLOW_UP_LIST_TABS, "voicemails", "skipped"] as const;
export type FollowUpTab = (typeof FOLLOW_UP_TABS)[number];

export const FOLLOW_UP_TAB_LABELS: Readonly<Record<FollowUpTab, string>> = {
  overdue: "Overdue",
  today: "Today",
  upcoming: "Upcoming",
  completed: "Completed",
  voicemails: "Voicemails",
  skipped: "Skipped",
};

export const FOLLOW_UPS_PAGE_SIZE = 25;
const MAX_PAGE = 100_000;

export interface FollowUpParams {
  /** null when the URL names no (valid) tab; the page then picks Overdue or Today. */
  tab: FollowUpTab | null;
  page: number;
}

export type RawSearchParams = Record<string, string | string[] | undefined> | URLSearchParams;

const tabSchema = z.enum(FOLLOW_UP_TABS);
const pageSchema = z.coerce.number().int().min(1).max(MAX_PAGE);

function first(raw: RawSearchParams, key: string): string | undefined {
  if (raw instanceof URLSearchParams) return raw.get(key) ?? undefined;
  const value = raw[key];
  return Array.isArray(value) ? value[0] : value;
}

/** Lenient: a missing or bad value falls back to its default instead of failing the page. */
export function parseFollowUpParams(raw: RawSearchParams): FollowUpParams {
  const tabResult = tabSchema.safeParse(first(raw, "tab")?.trim().toLowerCase());
  const pageRaw = first(raw, "page")?.trim();
  const pageResult = pageRaw && /^\d+$/.test(pageRaw) ? pageSchema.safeParse(pageRaw) : null;
  return {
    tab: tabResult.success ? tabResult.data : null,
    page: pageResult?.success ? pageResult.data : 1,
  };
}

/** Default tab when the URL has none: Overdue while anything is overdue, otherwise Today. */
export function defaultFollowUpTab(overdueCount: number): FollowUpTab {
  return overdueCount > 0 ? "overdue" : "today";
}

export function followUpsHref(tab: FollowUpTab, page = 1): string {
  const search = new URLSearchParams({ tab });
  if (page > 1) search.set("page", String(page));
  return `/follow-ups?${search.toString()}`;
}

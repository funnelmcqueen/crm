"use client";

import { ArrowDownWideNarrow, ArrowUpNarrowWide, ListFilter, Search, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { LEAD_STATUSES, STATUS_LABELS, type LeadStatus } from "@/lib/domain/statuses";
import { cn } from "@/lib/utils";
import {
  DEFAULT_SORT_DIR,
  LEAD_SORT_KEYS,
  LEAD_SORT_LABELS,
  MAX_QUERY_LENGTH,
  hasActiveFilters,
  leadListHref,
  type LeadListParams,
  type LeadSortKey,
} from "./list-params";

const ALL = "__all";
const SEARCH_DEBOUNCE_MS = 300;
const TALL_TRIGGER = "data-[size=default]:h-12 px-3 text-sm";

export interface ToolbarAgent {
  id: string;
  name: string;
  active: boolean;
}

export interface LeadsToolbarProps {
  params: LeadListParams;
  sources: string[];
  /** Admin only. */
  agents: ToolbarAgent[];
  isAdmin: boolean;
}

export function LeadsToolbar({ params, sources, agents, isAdmin }: LeadsToolbarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  // The URL is the state. Local copies only bridge the gap until the server render arrives, and follow
  // the URL when it changes from elsewhere (back button, links).
  const [query, setQuery] = useState(params.q);
  const [sentQuery, setSentQuery] = useState(params.q);
  const [syncedQuery, setSyncedQuery] = useState(params.q);
  if (params.q !== syncedQuery) {
    setSyncedQuery(params.q);
    if (params.q !== sentQuery) {
      setQuery(params.q);
      setSentQuery(params.q);
    }
  }

  const statusKey = params.statuses.join(",");
  const [statuses, setStatuses] = useState<LeadStatus[]>(params.statuses);
  const [syncedStatusKey, setSyncedStatusKey] = useState(statusKey);
  if (statusKey !== syncedStatusKey) {
    setSyncedStatusKey(statusKey);
    setStatuses(params.statuses);
  }

  const navigate = useCallback(
    (next: LeadListParams) => {
      startTransition(() => {
        router.replace(leadListHref(next, pathname), { scroll: false });
      });
    },
    [router, pathname],
  );

  useEffect(() => {
    const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH);
    if (trimmed === params.q) return;
    const timer = setTimeout(() => {
      setSentQuery(trimmed);
      navigate({ ...params, statuses, q: trimmed, page: 1 });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, params, statuses, navigate]);

  function update(patch: Partial<LeadListParams>) {
    const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH);
    setSentQuery(trimmed);
    navigate({ ...params, statuses, q: trimmed, ...patch, page: 1 });
  }

  function toggleStatus(status: LeadStatus, checked: boolean) {
    const next = checked
      ? LEAD_STATUSES.filter((s) => s === status || statuses.includes(s))
      : statuses.filter((s) => s !== status);
    setStatuses(next);
    update({ statuses: next });
  }

  function clearAll() {
    setQuery("");
    setStatuses([]);
    setSentQuery("");
    navigate({ ...params, q: "", statuses: [], source: null, agent: null, unassigned: false, page: 1 });
  }

  const sourceOptions = params.source && !sources.includes(params.source) ? [params.source, ...sources] : sources;
  const filtersActive = hasActiveFilters({ ...params, q: query.trim(), statuses });
  const SortIcon = params.dir === "asc" ? ArrowUpNarrowWide : ArrowDownWideNarrow;

  return (
    <div className="mb-4 flex flex-col gap-2" aria-busy={pending || undefined}>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          inputMode="search"
          enterKeyHint="search"
          aria-label="Search leads"
          placeholder="Search business, contact, phone, email, website, city"
          value={query}
          maxLength={MAX_QUERY_LENGTH}
          onChange={(event) => setQuery(event.target.value)}
          className="h-12 pl-11 text-base md:text-sm"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="h-12 gap-2 px-3">
              <ListFilter aria-hidden />
              Status
              {statuses.length > 0 ? (
                <span className="min-w-5 rounded-full bg-primary px-1.5 text-xs font-extrabold text-primary-foreground tabular-nums">
                  {statuses.length}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 gap-0 p-1">
            <div role="group" aria-label="Filter by status" className="max-h-[min(24rem,60dvh)] overflow-y-auto">
              {LEAD_STATUSES.map((status) => {
                const id = `lead-status-filter-${status}`;
                return (
                  <label
                    key={status}
                    htmlFor={id}
                    className="flex min-h-12 cursor-pointer items-center gap-3 rounded-md px-3 text-sm transition-colors duration-100 hover:bg-muted"
                  >
                    <Checkbox
                      id={id}
                      checked={statuses.includes(status)}
                      onCheckedChange={(checked) => toggleStatus(status, checked === true)}
                    />
                    {STATUS_LABELS[status]}
                  </label>
                );
              })}
            </div>
            {statuses.length > 0 ? (
              <Button
                variant="ghost"
                className="mt-1 h-12 w-full"
                onClick={() => {
                  setStatuses([]);
                  update({ statuses: [] });
                }}
              >
                Clear statuses
              </Button>
            ) : null}
          </PopoverContent>
        </Popover>

        <Select value={params.source ?? ALL} onValueChange={(value) => update({ source: value === ALL ? null : value })}>
          <SelectTrigger aria-label="Filter by source" className={cn(TALL_TRIGGER, "min-w-36")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={ALL} className="min-h-11">
              All sources
            </SelectItem>
            {sourceOptions.map((source) => (
              <SelectItem key={source} value={source} className="min-h-11">
                {source}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isAdmin ? (
          <>
            <Select
              value={params.unassigned ? ALL : (params.agent ?? ALL)}
              disabled={params.unassigned}
              onValueChange={(value) => update({ agent: value === ALL ? null : value })}
            >
              <SelectTrigger aria-label="Filter by agent" className={cn(TALL_TRIGGER, "min-w-40")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem value={ALL} className="min-h-11">
                  All agents
                </SelectItem>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id} className="min-h-11">
                    {agent.name}
                    {agent.active ? "" : " (disabled)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex h-12 items-center gap-2 rounded-lg border px-3">
              <Switch
                id="leads-unassigned-filter"
                checked={params.unassigned}
                onCheckedChange={(checked) => update({ unassigned: checked, agent: checked ? null : params.agent })}
              />
              <Label htmlFor="leads-unassigned-filter" className="cursor-pointer text-sm">
                Unassigned
              </Label>
            </div>
          </>
        ) : null}

        <div className="flex items-center gap-1">
          <Select
            value={params.sort}
            onValueChange={(value) => {
              const sort = value as LeadSortKey;
              if (LEAD_SORT_KEYS.includes(sort)) update({ sort, dir: DEFAULT_SORT_DIR[sort] });
            }}
          >
            <SelectTrigger aria-label="Sort by" className={cn(TALL_TRIGGER, "min-w-40")}>
              <span className="text-muted-foreground">Sort:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {LEAD_SORT_KEYS.map((key) => (
                <SelectItem key={key} value={key} className="min-h-11">
                  {LEAD_SORT_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            className="size-12"
            aria-label={params.dir === "asc" ? "Sorted ascending. Sort descending" : "Sorted descending. Sort ascending"}
            onClick={() => update({ dir: params.dir === "asc" ? "desc" : "asc" })}
          >
            <SortIcon aria-hidden className="size-5" />
          </Button>
        </div>

        {filtersActive ? (
          <Button variant="ghost" className="h-12 gap-1.5 px-3 text-muted-foreground" onClick={clearAll}>
            <X aria-hidden />
            Clear
          </Button>
        ) : null}

        <span aria-live="polite" className="text-xs text-muted-foreground">
          {pending ? "Updating…" : ""}
        </span>
      </div>
    </div>
  );
}

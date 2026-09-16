"use client";

// The Leads page selection, kept outside React so it survives the page's server re-renders (paging and sorting
// replace the table) and, through sessionStorage, a reload of the same tab. Per-viewer convenience only: it is a
// list of ids, never trusted by the server, which re-checks every lead on every bulk action.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { MAX_BULK_LEADS } from "@/lib/domain/bulk-leads";

const STORAGE_KEY = "fmq.leadSelection";

export type SelectionNotice = "filters-changed" | null;

interface SelectionState {
  scope: string | null;
  ids: ReadonlySet<string>;
  /** Why the selection was just emptied, shown once next to the list. */
  notice: SelectionNotice;
}

const EMPTY: SelectionState = { scope: null, ids: new Set(), notice: null };

let state: SelectionState = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function load(): void {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { scope?: unknown; ids?: unknown };
    if (typeof parsed.scope !== "string" || !Array.isArray(parsed.ids)) return;
    const ids = parsed.ids.filter((id): id is string => typeof id === "string").slice(0, MAX_BULK_LEADS);
    state = { scope: parsed.scope, ids: new Set(ids), notice: null };
  } catch {
    // Storage blocked or corrupt: start empty.
  }
}

function persist(): void {
  try {
    if (state.scope === null || state.ids.size === 0) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ scope: state.scope, ids: [...state.ids] }));
  } catch {
    // Storage blocked: the selection still works for this page view.
  }
}

function setState(next: SelectionState): void {
  state = next;
  persist();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): SelectionState {
  load();
  return state;
}

function getServerSnapshot(): SelectionState {
  return EMPTY;
}

/** Switches the store to `scope`. A different scope starts empty, noting it when that dropped a selection. */
function enterScope(scope: string): void {
  load();
  if (state.scope === scope) return;
  setState({ scope, ids: new Set(), notice: state.ids.size > 0 && state.scope !== null ? "filters-changed" : null });
}

export interface LeadSelection {
  ids: ReadonlySet<string>;
  count: number;
  notice: SelectionNotice;
  replace(ids: Iterable<string>): void;
  clear(): void;
  dismissNotice(): void;
}

export function useLeadSelection(scope: string): LeadSelection {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    enterScope(scope);
  }, [scope]);

  // Until the effect has switched scopes, a selection from another scope must not show here.
  const current = snapshot.scope === scope ? snapshot : EMPTY;

  const replace = useCallback(
    (ids: Iterable<string>) => {
      const next = new Set<string>();
      for (const id of ids) {
        if (next.size >= MAX_BULK_LEADS) break;
        next.add(id);
      }
      setState({ scope, ids: next, notice: null });
    },
    [scope],
  );
  const clear = useCallback(() => setState({ scope, ids: new Set(), notice: null }), [scope]);
  const dismissNotice = useCallback(() => {
    if (state.notice !== null) setState({ ...state, notice: null });
  }, []);

  return { ids: current.ids, count: current.ids.size, notice: current.notice, replace, clear, dismissNotice };
}

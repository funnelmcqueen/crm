// Per-device pep-talk state (docs/DEVIATIONS.md D49): the agent's setting, today's call count and
// the lines they have already seen today.
//
// This lives in localStorage rather than on the profile, exactly like the call-mode preference it
// sits next to in Settings: it is a taste, it is per-device, and none of it is worth a migration or
// a round trip. Losing it costs an agent one repeated joke.
import { useSyncExternalStore } from "react";
import { type PepSetting } from "@/lib/domain/pep-talk";

export const PEP_SETTING_KEY = "fmq.pepTalk";
export const PEP_DAY_KEY = "fmq.pepDay";

/** Chosen for us by the team that asked for this: sales floor by default, mutable per agent. */
export const DEFAULT_PEP_SETTING: PepSetting = "raw";

/** How many line ids to remember, so a shift doesn't repeat itself while the pool lasts. */
const RECENT_LIMIT = 30;

function isPepSetting(value: unknown): value is PepSetting {
  return value === "raw" || value === "salty" || value === "clean" || value === "off";
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Some privacy modes throw on access.
    return null;
  }
}

export function readPepSetting(source: Pick<Storage, "getItem"> | null = storage()): PepSetting {
  try {
    const value = source?.getItem(PEP_SETTING_KEY);
    return isPepSetting(value) ? value : DEFAULT_PEP_SETTING;
  } catch {
    return DEFAULT_PEP_SETTING;
  }
}

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === PEP_SETTING_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function writePepSetting(setting: PepSetting): void {
  try {
    storage()?.setItem(PEP_SETTING_KEY, setting);
  } catch {
    // Storage blocked: the choice still applies until reload.
  }
  for (const listener of listeners) listener();
}

/**
 * Renders the default on the server and on the first client paint, then the stored value. Pep lines
 * are client-only for this reason: a line the agent muted must never flash up before hydration.
 */
export function usePepSetting(): [PepSetting, (setting: PepSetting) => void] {
  const setting = useSyncExternalStore(
    subscribe,
    () => readPepSetting(),
    () => DEFAULT_PEP_SETTING,
  );
  return [setting, writePepSetting];
}

export interface PepDay {
  date: string;
  calls: number;
  recent: string[];
  /** The agent's daily target, left here by the dashboard so the outcome toast can spot milestones. */
  target: number;
}

function emptyDay(date: string): PepDay {
  return { date, calls: 0, recent: [], target: 0 };
}

/** The device's own calendar day, which is the day an agent means when they say "today". */
export function localDate(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, so string comparison is date comparison.
  return now.toLocaleDateString("en-CA");
}

/** Today's counters, reset whenever the local date rolls over. */
export function readPepDay(date: string): PepDay {
  try {
    const raw = storage()?.getItem(PEP_DAY_KEY);
    if (!raw) return emptyDay(date);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return emptyDay(date);
    const day = parsed as Partial<PepDay>;
    if (day.date !== date || typeof day.calls !== "number" || !Number.isFinite(day.calls)) return emptyDay(date);
    const recent = Array.isArray(day.recent) ? day.recent.filter((id): id is string => typeof id === "string") : [];
    const target = typeof day.target === "number" && Number.isFinite(day.target) ? Math.max(0, Math.trunc(day.target)) : 0;
    return { date, calls: Math.max(0, Math.trunc(day.calls)), recent: recent.slice(-RECENT_LIMIT), target };
  } catch {
    return emptyDay(date);
  }
}

function writePepDay(day: PepDay): void {
  try {
    storage()?.setItem(PEP_DAY_KEY, JSON.stringify(day));
  } catch {
    // Nothing to do: the counters simply restart.
  }
}

/** Counts one logged call and returns the running total for the day. */
export function countLoggedCall(date: string): number {
  const day = readPepDay(date);
  const next = { ...day, calls: day.calls + 1 };
  writePepDay(next);
  return next.calls;
}

/** The dashboard knows the agent's target; the outcome toast doesn't, so it is left here in passing. */
export function rememberPepTarget(date: string, target: number): void {
  const day = readPepDay(date);
  if (day.target === target) return;
  writePepDay({ ...day, target });
}

export function rememberPepLine(date: string, id: string): void {
  const day = readPepDay(date);
  writePepDay({ ...day, recent: [...day.recent.filter((seen) => seen !== id), id].slice(-RECENT_LIMIT) });
}

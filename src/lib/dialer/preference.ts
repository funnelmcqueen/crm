import { useSyncExternalStore } from "react";
import type { CallModePreference } from "./types";

export const CALL_MODE_STORAGE_KEY = "fmq.callMode";

export const CALL_MODE_PREFERENCES: readonly CallModePreference[] = ["auto", "in-app", "phone"];

export const CALL_MODE_LABELS: Readonly<Record<CallModePreference, string>> = {
  auto: "Auto",
  "in-app": "Always in-app",
  phone: "Always phone",
};

export function isCallModePreference(value: unknown): value is CallModePreference {
  return typeof value === "string" && (CALL_MODE_PREFERENCES as readonly string[]).includes(value);
}

export function readCallModePreference(storage: Pick<Storage, "getItem"> | null | undefined): CallModePreference {
  try {
    const value = storage?.getItem(CALL_MODE_STORAGE_KEY);
    return isCallModePreference(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Some privacy modes throw on access.
    return null;
  }
}

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === CALL_MODE_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

const getSnapshot = (): CallModePreference => readCallModePreference(browserStorage());
const getServerSnapshot = (): CallModePreference => "auto";

export function writeCallModePreference(preference: CallModePreference): void {
  try {
    browserStorage()?.setItem(CALL_MODE_STORAGE_KEY, preference);
  } catch {
    // Storage full or blocked: the choice still applies until reload.
  }
  for (const listener of listeners) listener();
}

/** Per-device call mode (Settings: Auto / Always in-app / Always phone). Renders "auto" on the server. */
export function useCallModePreference(): [CallModePreference, (preference: CallModePreference) => void] {
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [preference, writeCallModePreference];
}

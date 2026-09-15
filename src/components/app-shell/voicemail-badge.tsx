"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { VOICEMAILS_CHANGED_EVENT } from "@/lib/dialer/events";
import { unheardVoicemailCountAction } from "@/server/actions/calls";
import { createVoicemailCountStore } from "./voicemail-count-store";

const POLL_INTERVAL_MS = 60_000;

// The shell renders every badge twice (sidebar and tab bar), so both instances share one store and
// one poller instead of fetching separately.
const store = createVoicemailCountStore(async () => {
  const result = await unheardVoicemailCountAction();
  return result.ok ? result.data : null;
});
let pollTimer: ReturnType<typeof setInterval> | null = null;

function onVisibleRefetch() {
  if (document.visibilityState === "visible") void store.refetch();
}

function subscribe(listener: () => void): () => void {
  const unsubscribe = store.subscribe(listener);
  if (store.listenerCount() === 1) {
    pollTimer = setInterval(onVisibleRefetch, POLL_INTERVAL_MS);
    window.addEventListener("focus", onVisibleRefetch);
    window.addEventListener(VOICEMAILS_CHANGED_EVENT, onVisibleRefetch);
  }
  return () => {
    unsubscribe();
    if (store.listenerCount() === 0) {
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
      window.removeEventListener("focus", onVisibleRefetch);
      window.removeEventListener(VOICEMAILS_CHANGED_EVENT, onVisibleRefetch);
    }
  };
}

const getServerSnapshot = () => null;

export interface VoicemailBadgeProps {
  /** The signed-in user; a count fetched for anyone else is never shown. */
  userId: string;
  /** Fetched by the (app) layout on the server. */
  initialCount: number;
}

/** Unheard voicemail count on the Follow-ups nav item. Hidden at zero. */
export function VoicemailBadge({ userId, initialCount }: VoicemailBadgeProps) {
  const getSnapshot = useCallback(() => store.snapshot(userId), [userId]);
  const live = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // A fresh server render (router.refresh, or another user signing in) carries a newer count.
  useEffect(() => {
    store.set(userId, initialCount);
  }, [userId, initialCount]);

  const count = live ?? initialCount;
  if (count <= 0) return null;
  return (
    <span
      role="status"
      aria-label={`${count} unheard voicemail${count === 1 ? "" : "s"}`}
      className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] leading-none font-extrabold text-primary-foreground tabular-nums"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

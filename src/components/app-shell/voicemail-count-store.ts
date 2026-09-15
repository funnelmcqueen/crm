export interface VoicemailCountStore {
  /** The latest count for this user, or null when none is known for them. */
  snapshot(userId: string): number | null;
  set(userId: string, count: number): void;
  /** Fetches for the user last passed to `set`; a result that arrives after the user changed is dropped. */
  refetch(): Promise<void>;
  subscribe(listener: () => void): () => void;
  listenerCount(): number;
}

/**
 * One count shared by every badge in the tab. It is keyed by user because module state survives soft
 * navigations, including signing in as someone else in the same tab.
 */
export function createVoicemailCountStore(fetchCount: () => Promise<number | null>): VoicemailCountStore {
  let owner: string | null = null;
  let count: number | null = null;
  let inflight: { userId: string; promise: Promise<void> } | null = null;
  const listeners = new Set<() => void>();

  function set(userId: string, next: number): void {
    if (owner === userId && count === next) return;
    owner = userId;
    count = next;
    for (const listener of [...listeners]) listener();
  }

  return {
    snapshot: (userId) => (owner === userId ? count : null),
    set,
    refetch() {
      const requestedFor = owner;
      if (requestedFor === null) return Promise.resolve();
      if (inflight?.userId === requestedFor) return inflight.promise;
      const entry: { userId: string; promise: Promise<void> } = { userId: requestedFor, promise: Promise.resolve() };
      entry.promise = (async () => {
        try {
          const next = await fetchCount();
          if (next !== null && owner === requestedFor) set(requestedFor, next);
        } catch {
          // Offline: keep showing the last count.
        } finally {
          if (inflight === entry) inflight = null;
        }
      })();
      inflight = entry;
      return entry.promise;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount: () => listeners.size,
  };
}

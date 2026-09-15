// The nav badge store is shared by every badge instance in the tab and outlives a soft navigation, so a
// count must never be shown to a different signed-in user than the one it was fetched for.
import { describe, expect, it, vi } from 'vitest';
import { createVoicemailCountStore } from '@/components/app-shell/voicemail-count-store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createVoicemailCountStore', () => {
  it("never returns the previous user's count to the next user", () => {
    const store = createVoicemailCountStore(async () => null);
    store.set('user-a', 3);
    expect(store.snapshot('user-a')).toBe(3);
    expect(store.snapshot('user-b')).toBeNull();
    store.set('user-b', 0);
    expect(store.snapshot('user-a')).toBeNull();
    expect(store.snapshot('user-b')).toBe(0);
  });

  it('drops a refetch that finishes after the signed-in user changed', async () => {
    const pending = deferred<number | null>();
    const store = createVoicemailCountStore(() => pending.promise);
    store.set('user-a', 1);
    const refetch = store.refetch();
    store.set('user-b', 0);
    pending.resolve(7);
    await refetch;
    expect(store.snapshot('user-b')).toBe(0);
    expect(store.snapshot('user-a')).toBeNull();
  });

  it('applies a refetch for the current user and notifies subscribers only on changes', async () => {
    let next: number | null = 4;
    const store = createVoicemailCountStore(async () => next);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set('user-a', 2);
    expect(listener).toHaveBeenCalledTimes(1);
    await store.refetch();
    expect(store.snapshot('user-a')).toBe(4);
    expect(listener).toHaveBeenCalledTimes(2);
    await store.refetch();
    expect(listener).toHaveBeenCalledTimes(2);
    next = null;
    await store.refetch();
    expect(store.snapshot('user-a')).toBe(4);
    unsubscribe();
    store.set('user-a', 9);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not fetch before a user is known', async () => {
    const fetchCount = vi.fn(async () => 5);
    const store = createVoicemailCountStore(fetchCount);
    await store.refetch();
    expect(fetchCount).not.toHaveBeenCalled();
  });
});

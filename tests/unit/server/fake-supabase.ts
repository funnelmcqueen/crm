// A minimal stand-in for the supabase-js client, used by unit tests that need to reproduce behavior
// the real stack only shows at scale or on failure:
//
//   * PostgREST truncates an unpaginated select at db-max-rows (localbase: MAX_ROWS = 1000). A service
//     that awaits `.select()` without a range silently receives a partial table and cannot tell.
//   * A query that fails only on the second page exercises the streaming error path.
//
// The fake is deliberately literal: it records the chained operations and hands them to a responder,
// so a test can enforce the row cap exactly the way PostgREST does.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { Profile, RequestContext } from '@/server/context';

export interface QueryOp {
  kind: 'eq' | 'in' | 'order' | 'range' | 'limit' | 'is';
  args: unknown[];
}

export interface QueryCall {
  /** 'from:<table>' or 'rpc:<function>' */
  target: string;
  /** Column list for a select, or the RPC arguments. */
  payload: unknown;
  ops: QueryOp[];
}

export type Responder = (call: QueryCall) => { data: unknown; error: unknown };

/** Chainable, thenable builder: every method returns itself and awaiting it calls the responder. */
function builder(call: QueryCall, respond: Responder) {
  const chain: Record<string, unknown> = {};
  for (const kind of ['eq', 'in', 'order', 'range', 'limit', 'is'] as const) {
    chain[kind] = (...args: unknown[]) => {
      call.ops.push({ kind, args });
      return chain;
    };
  }
  chain.select = () => chain;
  chain.maybeSingle = () => Promise.resolve(respond(call));
  chain.single = () => Promise.resolve(respond(call));
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(respond(call)).then(resolve, reject);
  return chain;
}

export interface FakeClient {
  client: SupabaseClient<Database>;
  calls: QueryCall[];
}

export function fakeSupabase(respond: Responder): FakeClient {
  const calls: QueryCall[] = [];
  const record = (target: string, payload: unknown) => {
    const call: QueryCall = { target, payload, ops: [] };
    calls.push(call);
    return builder(call, respond);
  };
  const client = {
    from: (table: string) => ({ select: (columns: string) => record(`from:${table}`, columns) }),
    rpc: (fn: string, args: unknown) => record(`rpc:${fn}`, args),
  };
  return { client: client as unknown as SupabaseClient<Database>, calls };
}

/** The range a call asked for, or null when it awaited the whole table. */
export function rangeOf(call: QueryCall): { from: number; to: number } | null {
  const op = [...call.ops].reverse().find((entry) => entry.kind === 'range');
  return op ? { from: Number(op.args[0]), to: Number(op.args[1]) } : null;
}

/**
 * Applies the row cap the way PostgREST does for a caller that pages within it: an explicit range is
 * served in full (a service must choose a page size at or below db-max-rows, which these services do),
 * while a request with no range gets at most `cap` rows and no indication that more exist.
 */
export function applyRowCap<T>(rows: readonly T[], call: QueryCall, cap: number): T[] {
  const range = rangeOf(call);
  if (!range) return rows.slice(0, cap);
  return rows.slice(range.from, range.to + 1);
}

export function fakeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'admin@example.test',
    name: 'Fake Admin',
    role: 'ADMIN',
    active: true,
    daily_call_target: 50,
    timezone: 'America/New_York',
    in_app_calling_enabled: true,
    device_seen_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Profile;
}

export function fakeContext(client: SupabaseClient<Database>, profile: Profile = fakeProfile()): RequestContext {
  return { supabase: client, userId: profile.id, profile };
}

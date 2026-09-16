// Review round 2 claim: "an error after the first page of a CSV export aborts the body under HTTP 200,
// so the admin can end up with a silently truncated file".
//
// The first page is fetched eagerly, so auth and query errors still produce a clean error response.
// This pins down what actually happens when a *later* page fails: the response body must fail loudly
// rather than end as if the export were complete.
import { describe, expect, it } from 'vitest';
import { createLeadExport } from '@/server/services/export';
import { fakeContext, fakeSupabase, type QueryCall } from './fake-supabase';

function lead(id: string, name: string) {
  return {
    id,
    created_at: '2026-09-15T10:00:00Z',
    business_name: name,
    contact_name: null,
    phone: '+12125550100',
    email: null,
    website: null,
    address: null,
    city: null,
    state: null,
    country: null,
    status: 'NEW',
    notes: null,
    last_contacted_at: null,
    next_follow_up_at: null,
    call_count: 0,
    assigned_to: null,
  };
}

const PAGE_ONE = [lead('11111111-0000-4000-8000-000000000001', 'Page One A')];

/** Page 1 succeeds, page 2 fails: the failure happens after the response has begun streaming. */
function failOnSecondPage(call: QueryCall) {
  if (call.target === 'from:profiles') return { data: [], error: null };
  if (call.target === 'rpc:export_leads') {
    const after = (call.payload as { p_after_id?: string }).p_after_id;
    if (!after) return { data: PAGE_ONE, error: null };
    return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
  }
  throw new Error(`unexpected call ${call.target}`);
}

describe('an export that fails after the first page', () => {
  it('errors the stream instead of ending it like a complete file', async () => {
    const { client } = fakeSupabase(failOnSecondPage);
    const csv = await createLeadExport(fakeContext(client), { q: '', statuses: [], source: null, agent: null, unassigned: false }, { pageSize: 1 });

    // Reading the body must reject. A truncated-but-successful read would mean the admin silently
    // receives a short file, which is the reported failure mode.
    await expect(new Response(csv.stream).arrayBuffer()).rejects.toThrow();
  });

  it('still returns cleanly when the first page itself fails, before any bytes are sent', async () => {
    const { client } = fakeSupabase((call) => {
      if (call.target === 'from:profiles') return { data: [], error: null };
      return { data: null, error: { code: '42501', message: 'permission denied' } };
    });
    await expect(
      createLeadExport(fakeContext(client), { q: '', statuses: [], source: null, agent: null, unassigned: false }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

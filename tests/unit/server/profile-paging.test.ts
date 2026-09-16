// Review round 2: two admin-only lookups read the whole profiles table in one unpaginated request and
// treat the result as complete. PostgREST caps an unpaginated response (localbase: MAX_ROWS = 1000;
// real Supabase does the same whenever db-max-rows is set), so past that many profiles:
//
//   * the CSV export labels leads owned by the truncated agents "Unknown user", silently
//     misattributing real leads in a file the admin uses for reporting and reassignment, and
//   * the Agent filter on /leads and /pipeline drops those agents entirely.
//
// The cap is what makes this visible, so these tests reproduce it with a client that truncates the
// way PostgREST does rather than by creating a thousand users.
import { describe, expect, it } from 'vitest';
import { listAgentsForFilter } from '@/server/services/leads';
import { createLeadExport, EXPORT_ASSIGNED_AGENT_HEADER } from '@/server/services/export';
import { applyRowCap, fakeContext, fakeProfile, fakeSupabase, rangeOf, type QueryCall } from './fake-supabase';

/** Fewer than the real 1000 so the test stays small; the failure mode is identical. */
const ROW_CAP = 2;

const PROFILES = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Aaron First', email: 'aaron@example.test', active: true, role: 'AGENT' },
  { id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Bella Second', email: 'bella@example.test', active: true, role: 'AGENT' },
  // Past the cap: only a paged read ever sees this one.
  { id: 'cccccccc-0000-4000-8000-000000000003', name: 'Carla Third', email: 'carla@example.test', active: true, role: 'AGENT' },
];

const LEAD = {
  id: 'dddddddd-0000-4000-8000-000000000001',
  created_at: '2026-09-15T10:00:00Z',
  business_name: 'Third Owned Co',
  contact_name: null,
  phone: '+12125550100',
  email: null,
  website: null,
  address: null,
  city: 'Austin',
  state: null,
  country: null,
  status: 'NEW',
  notes: null,
  last_contacted_at: null,
  next_follow_up_at: null,
  call_count: 0,
  // Owned by the agent that sits beyond the cap.
  assigned_to: PROFILES[2].id,
};

function respondWithCap(call: QueryCall) {
  if (call.target === 'from:profiles') return { data: applyRowCap(PROFILES, call, ROW_CAP), error: null };
  if (call.target === 'rpc:export_leads') {
    const after = (call.payload as { p_after_id?: string }).p_after_id;
    return { data: after ? [] : [LEAD], error: null };
  }
  throw new Error(`unexpected call ${call.target}`);
}

async function csvText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await new Response(stream).arrayBuffer()));
}

describe('admin CSV export owner lookup', () => {
  it('names the owner of a lead whose agent sits past the unpaginated row cap', async () => {
    const { client } = fakeSupabase(respondWithCap);
    const csv = await createLeadExport(fakeContext(client), {
      q: '',
      statuses: [],
      source: null,
      agent: null,
      unassigned: false,
    });

    const text = await csvText(csv.stream);
    expect(csv.headers).toContain(EXPORT_ASSIGNED_AGENT_HEADER);
    expect(text).toContain('Carla Third');
    expect(text).not.toContain('Unknown user');
  });

  it('reads the profile table in pages instead of assuming one request returns all of it', async () => {
    const { client, calls } = fakeSupabase(respondWithCap);
    const csv = await createLeadExport(fakeContext(client), {
      q: '',
      statuses: [],
      source: null,
      agent: null,
      unassigned: false,
    });
    await csvText(csv.stream);

    const profileCalls = calls.filter((call) => call.target === 'from:profiles');
    expect(profileCalls.length).toBeGreaterThan(0);
    for (const call of profileCalls) expect(rangeOf(call), 'every profile read is ranged').not.toBeNull();
  });
});

describe('agent filter options', () => {
  it('lists agents past the unpaginated row cap', async () => {
    const { client } = fakeSupabase(respondWithCap);
    const options = await listAgentsForFilter(fakeContext(client));
    expect(options.map((option) => option.name)).toEqual(['Aaron First', 'Bella Second', 'Carla Third']);
  });

  it('is still admin only', async () => {
    const { client } = fakeSupabase(respondWithCap);
    const agentCtx = fakeContext(client, fakeProfile({ role: 'AGENT' }));
    await expect(listAgentsForFilter(agentCtx)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

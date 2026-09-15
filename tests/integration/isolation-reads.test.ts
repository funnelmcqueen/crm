// SPEC 13 agent isolation, read side: Agent A (alex) must not be able to see anything of Agent B
// (blair), other agents, unassigned leads or admin-only rows, through any supabase-js path.
// Seeded data is read-only here; the one fixture (a lead with unique search tokens) is created fresh.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { LEAD_STATUSES, SEED_LEADS, UNMATCHED_VOICEMAIL, type LeadStatus } from '../../scripts/lib/seed-data';
import { clientWithAccessToken, serviceClient, signInAs, type SignedInUser } from '../helpers/clients';
import { createLead, createUser, type Lead } from '../helpers/fixtures';
import { expectEmptyRows, expectError } from '../helpers/isolation';
import { seededLeadId, seededPhoneNumberId, signInSeeded } from '../helpers/seeded';

type AgentKey = 'alex' | 'blair' | 'casey';
const AGENTS: readonly AgentKey[] = ['alex', 'blair', 'casey'];

const HIDDEN_CALL_COLUMNS = ['user_id', 'provider_call_sid', 'voicemail_recording_sid', 'phone_number_id'] as const;
const ALLOWED_CALL_COLUMNS = 'id, created_at, lead_id, direction, mode, remote_e164, call_status, outcome, notes, duration_seconds, voicemail_duration_seconds, handled_at';

let sessions: Record<AgentKey | 'admin', SignedInUser>;
let leadsByOwner: Map<string | null, Lead[]>;
let alex: SignedInUser;
let blair: SignedInUser;
let alexLeadIds: Set<string>;
let blairLeads: Lead[];
let foreignToAlex: Lead[];
let blairCallIds: string[];
let alexVoicemailCallId: string;
let unmatchedVoicemailCallId: string;
let shadowOwner: SignedInUser;
let shadowLead: Lead;
const SHADOW_TOKEN = `zqx${randomUUID().slice(0, 8)}`;

async function scopedLeadIds(userId: string): Promise<string[]> {
  return (leadsByOwner.get(userId) ?? []).map((l) => l.id);
}

beforeAll(async () => {
  const [admin, a, b, c] = await Promise.all([
    signInSeeded('admin'),
    signInSeeded('alex'),
    signInSeeded('blair'),
    signInSeeded('casey'),
  ]);
  sessions = { admin, alex: a, blair: b, casey: c };
  alex = a;
  blair = b;

  // Fixture: an agent whose lead carries unique tokens in every searchable column.
  const owner = await createUser({ name: `Shadow ${SHADOW_TOKEN}` });
  shadowLead = await createLead({
    assigned_to: owner.id,
    business_name: `Shadow Biz ${SHADOW_TOKEN}`,
    contact_name: `Shadow Contact ${SHADOW_TOKEN}`,
    email: `${SHADOW_TOKEN}@shadow.test`,
    website: `${SHADOW_TOKEN}.shadow.test`,
    city: `City${SHADOW_TOKEN}`,
    source: `Source ${SHADOW_TOKEN}`,
    notes: `Notes ${SHADOW_TOKEN}`,
  });
  shadowOwner = await signInAs(owner.email, owner.password);

  const service = serviceClient();
  const seededIds = await Promise.all(SEED_LEADS.map((l) => seededLeadId(l.ref)));
  const { data: rows, error } = await service.from('leads').select('*').in('id', seededIds);
  if (error || !rows) throw new Error(`load seeded leads: ${error?.message}`);
  expect(rows).toHaveLength(SEED_LEADS.length);
  leadsByOwner = new Map();
  for (const row of rows) leadsByOwner.set(row.assigned_to, [...(leadsByOwner.get(row.assigned_to) ?? []), row]);

  alexLeadIds = new Set(await scopedLeadIds(alex.userId));
  expect(alexLeadIds.size).toBe(12);
  blairLeads = leadsByOwner.get(blair.userId) ?? [];
  expect(blairLeads).toHaveLength(12);
  foreignToAlex = [...rows.filter((l) => l.assigned_to !== alex.userId), shadowLead];

  const calls = await service.from('calls').select('id, lead_id').in('lead_id', blairLeads.map((l) => l.id));
  if (calls.error || !calls.data) throw new Error(`load blair calls: ${calls.error?.message}`);
  blairCallIds = calls.data.map((c) => c.id);
  expect(blairCallIds.length).toBeGreaterThan(0);

  const alexVm = await service
    .from('calls')
    .select('id')
    .eq('lead_id', await seededLeadId('alex-06'))
    .not('voicemail_recording_sid', 'is', null)
    .single();
  if (alexVm.error || !alexVm.data) throw new Error(`load alex-06 voicemail: ${alexVm.error?.message}`);
  alexVoicemailCallId = alexVm.data.id;

  const unmatched = await service
    .from('calls')
    .select('id, user_id')
    .is('lead_id', null)
    .eq('remote_e164', UNMATCHED_VOICEMAIL.remoteE164)
    .not('voicemail_recording_sid', 'is', null)
    .single();
  if (unmatched.error || !unmatched.data) throw new Error(`load unmatched voicemail: ${unmatched.error?.message}`);
  expect(unmatched.data.user_id).toBeNull();
  unmatchedVoicemailCallId = unmatched.data.id;
});

function expectOnlyOwn(rows: { id: string }[] | null, own: Set<string>): void {
  expect(rows).not.toBeNull();
  for (const row of rows ?? []) expect(own.has(row.id), `row ${row.id} is not the caller's`).toBe(true);
}

function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

describe("reading B's lead by id", () => {
  it('select + eq returns no rows for every lead not assigned to A', async () => {
    for (const lead of foreignToAlex) {
      expectEmptyRows(await alex.client.from('leads').select('id').eq('id', lead.id));
      expectEmptyRows(await alex.client.from('leads').select('*').eq('id', lead.id));
    }
  });

  it('single() errors exactly like a nonexistent id, maybeSingle() returns null', async () => {
    const target = blairLeads[0];
    const forB = await alex.client.from('leads').select('id, business_name').eq('id', target.id).single();
    const forRandom = await alex.client.from('leads').select('id, business_name').eq('id', randomUUID()).single();
    expectError(forB, 'PGRST116');
    expectError(forRandom, 'PGRST116');
    expect(forB.status).toBe(forRandom.status);
    expect(forB.error?.message).toBe(forRandom.error?.message);
    expect(JSON.stringify(forB.error)).not.toContain(target.business_name);

    const maybe = await alex.client.from('leads').select('id').eq('id', target.id).maybeSingle();
    expect(maybe.error).toBeNull();
    expect(maybe.data).toBeNull();
  });

  it('guessed random ids and bulk in() lists return nothing', async () => {
    const guesses = Array.from({ length: 25 }, () => randomUUID());
    expectEmptyRows(await alex.client.from('leads').select('id').in('id', guesses));
    expectEmptyRows(await alex.client.from('leads').select('id').in('id', foreignToAlex.map((l) => l.id)));
  });
});

describe("finding B's lead through filters", () => {
  const SEARCHABLE = ['business_name', 'contact_name', 'email', 'website', 'city', 'address', 'state', 'source', 'notes', 'phone_raw', 'website_domain'] as const;

  it('ilike and like on every searchable column never surface a foreign lead', async () => {
    for (const lead of blairLeads) {
      for (const column of SEARCHABLE) {
        const value = lead[column];
        if (!value) continue;
        const ilike = await alex.client.from('leads').select('id, assigned_to').ilike(column, `%${value}%`);
        expect(ilike.error).toBeNull();
        expectOnlyOwn(ilike.data, alexLeadIds);
        const like = await alex.client.from('leads').select('id').like(column, value);
        expectOnlyOwn(like.data, alexLeadIds);
      }
      const digits = lead.phone.slice(-7);
      expectEmptyRows(await alex.client.from('leads').select('id').like('phone', `%${digits}%`));
      expectEmptyRows(await alex.client.from('leads').select('id').eq('phone', lead.phone));
    }
  });

  it('or() combinations over every column return only own leads', async () => {
    for (const lead of foreignToAlex) {
      const parts = [
        `business_name.ilike.${quoted(`*${lead.business_name}*`)}`,
        `phone.eq.${quoted(lead.phone)}`,
        `id.eq.${lead.id}`,
      ];
      if (lead.contact_name) parts.push(`contact_name.ilike.${quoted(`*${lead.contact_name}*`)}`);
      if (lead.email) parts.push(`email.ilike.${quoted(`*${lead.email}*`)}`);
      if (lead.city) parts.push(`city.ilike.${quoted(lead.city)}`);
      const result = await alex.client.from('leads').select('id').or(parts.join(','));
      expect(result.error).toBeNull();
      expectOnlyOwn(result.data, alexLeadIds);
      expect(result.data?.map((r) => r.id)).not.toContain(lead.id);
    }
    expectEmptyRows(await alex.client.from('leads').select('id').or(`assigned_to.is.null,assigned_to.neq.${alex.userId}`));
    expectEmptyRows(await alex.client.from('leads').select('id').not('assigned_to', 'eq', alex.userId));
    expectEmptyRows(await alex.client.from('leads').select('id').eq('assigned_to', blair.userId));
    expectEmptyRows(await alex.client.from('leads').select('id').is('assigned_to', null));
    expectEmptyRows(await alex.client.from('leads').select('id').ilike('business_name', `%${SHADOW_TOKEN}%`));
  });

  it('order and range tricks page only through own leads', async () => {
    const all = await alex.client.from('leads').select('id', { count: 'exact' }).order('created_at').range(0, 999);
    expect(all.error).toBeNull();
    expect(new Set(all.data?.map((r) => r.id))).toEqual(alexLeadIds);
    expect(all.count).toBe(alexLeadIds.size);

    const beyond = await alex.client.from('leads').select('id').order('business_name').range(alexLeadIds.size, alexLeadIds.size + 200);
    expectEmptyRows(beyond);

    for (const column of ['assigned_to', 'call_count', 'last_contacted_at', 'phone'] as const) {
      for (const ascending of [true, false]) {
        const ordered = await alex.client.from('leads').select('id').order(column, { ascending, nullsFirst: !ascending }).limit(1000);
        expect(new Set(ordered.data?.map((r) => r.id))).toEqual(alexLeadIds);
      }
    }
    const wide = await alex.client.from('leads').select('id').gte('created_at', '1970-01-01T00:00:00Z').lte('call_count', 1_000_000);
    expect(new Set(wide.data?.map((r) => r.id))).toEqual(alexLeadIds);
  });

  it('search_leads never returns a foreign lead for any term, filter or sort', async () => {
    for (const lead of blairLeads) {
      const terms = [lead.business_name, lead.contact_name, lead.email, lead.website, lead.city, lead.phone, lead.phone.slice(-7), lead.phone.slice(-4)];
      for (const term of terms) {
        if (!term) continue;
        const { data, error } = await alex.client.rpc('search_leads', { p_query: term, p_limit: 100 });
        expect(error).toBeNull();
        expectOnlyOwn(data, alexLeadIds);
        expect(data?.map((r) => r.id)).not.toContain(lead.id);
      }
    }
    for (const token of [SHADOW_TOKEN, `Shadow Biz ${SHADOW_TOKEN}`, `${SHADOW_TOKEN}@shadow.test`]) {
      expectEmptyRows(await alex.client.rpc('search_leads', { p_query: token }));
      expectEmptyRows(await blair.client.rpc('search_leads', { p_query: token }));
    }
    // Sanity: the same query finds the lead for its owner.
    const own = await shadowOwner.client.rpc('search_leads', { p_query: SHADOW_TOKEN });
    expect(own.data?.map((r) => r.id)).toEqual([shadowLead.id]);

    const sorts = ['business_name', 'last_contacted_at', 'next_follow_up_at', 'call_count', 'created_at', 'assigned_to', 'created_at; drop table public.leads', '(select 1)'];
    for (const p_sort of sorts) {
      for (const p_dir of ['asc', 'desc', 'asc nulls first; --']) {
        const { data, error } = await alex.client.rpc('search_leads', {
          p_sort,
          p_dir,
          p_limit: 100,
          p_assigned_to: blair.userId,
          p_unassigned: true,
          p_statuses: [...LEAD_STATUSES] as LeadStatus[],
        });
        expect(error).toBeNull();
        expect(new Set(data?.map((r) => r.id))).toEqual(alexLeadIds);
        for (const row of data ?? []) {
          expect(row.assigned_to).toBe(alex.userId);
          expect(Number(row.total_count)).toBe(alexLeadIds.size);
        }
      }
    }
    expectEmptyRows(await alex.client.rpc('search_leads', { p_offset: alexLeadIds.size, p_limit: 100 }));
  });

  it("list_lead_sources lists only the caller's own sources", async () => {
    const expected = [...new Set((leadsByOwner.get(alex.userId) ?? []).map((l) => l.source).filter((s): s is string => !!s))].sort();
    const { data, error } = await alex.client.rpc('list_lead_sources');
    expect(error).toBeNull();
    expect([...(data ?? [])].sort()).toEqual(expected);
    expect(data).not.toContain(`Source ${SHADOW_TOKEN}`);
    expect((await shadowOwner.client.rpc('list_lead_sources')).data).toEqual([`Source ${SHADOW_TOKEN}`]);
  });

  it('can_access_lead is not an existence oracle', async () => {
    for (const lead of foreignToAlex.slice(0, 10)) {
      expect((await alex.client.rpc('can_access_lead', { p_lead_id: lead.id })).data).toBe(false);
    }
    expect((await alex.client.rpc('can_access_lead', { p_lead_id: randomUUID() })).data).toBe(false);
    expect((await alex.client.rpc('can_access_lead', { p_lead_id: [...alexLeadIds][0] })).data).toBe(true);
  });
});

describe('counts, aggregates and scoped RPCs', () => {
  it('count=exact head requests match exactly what each agent may see', async () => {
    const service = serviceClient();
    for (const key of AGENTS) {
      const session = sessions[key];
      const client = session.client;
      const ownLeadIds = await scopedLeadIds(session.userId);

      const leads = await client.from('leads').select('id', { count: 'exact', head: true });
      expect(leads.error).toBeNull();
      expect(leads.count).toBe(ownLeadIds.length);

      const leadCalls = await service.from('calls').select('id', { count: 'exact', head: true }).in('lead_id', ownLeadIds);
      const orphanCalls = await service.from('calls').select('id', { count: 'exact', head: true }).is('lead_id', null).eq('user_id', session.userId);
      const calls = await client.from('calls').select('id', { count: 'exact', head: true });
      expect(calls.error).toBeNull();
      expect(calls.count).toBe((leadCalls.count ?? 0) + (orphanCalls.count ?? 0));

      const ownFollowUps = await service.from('follow_ups').select('id', { count: 'exact', head: true }).eq('user_id', session.userId).in('lead_id', ownLeadIds);
      const followUps = await client.from('follow_ups').select('id', { count: 'exact', head: true });
      expect(followUps.error).toBeNull();
      expect(followUps.count).toBe(ownFollowUps.count);

      expect((await client.from('profiles').select('id', { count: 'exact', head: true })).count).toBe(1);
      expect((await client.from('phone_numbers').select('id', { count: 'exact', head: true })).count).toBe(0);
      expect((await client.from('settings').select('id', { count: 'exact', head: true })).count).toBe(0);
      expect((await client.from('leads').select('id', { count: 'exact', head: true }).in('id', foreignToAlex.map((l) => l.id)).neq('assigned_to', session.userId)).count).toBe(0);
    }
  });

  it('rate_limit_hits is not readable at all', async () => {
    expectError(await alex.client.from('rate_limit_hits').select('id'), '42501');
  });

  it('unheard_voicemail_count and list_voicemails are scoped to own leads', async () => {
    const service = serviceClient();
    for (const key of AGENTS) {
      const session = sessions[key];
      const ownLeadIds = await scopedLeadIds(session.userId);
      const { data: expectedRows } = await service
        .from('calls')
        .select('id, handled_at')
        .in('lead_id', ownLeadIds)
        .not('voicemail_recording_sid', 'is', null);
      const expectedIds = new Set((expectedRows ?? []).map((r) => r.id));
      const expectedUnheard = (expectedRows ?? []).filter((r) => r.handled_at === null).length;

      const count = await session.client.rpc('unheard_voicemail_count');
      expect(count.error).toBeNull();
      expect(count.data).toBe(expectedUnheard);

      const list = await session.client.rpc('list_voicemails', { p_limit: 100 });
      expect(list.error).toBeNull();
      expect(new Set(list.data?.map((r) => r.call_id))).toEqual(expectedIds);
      expect(list.data?.map((r) => r.call_id)).not.toContain(unmatchedVoicemailCallId);
      for (const row of list.data ?? []) expect(Number(row.total_count)).toBe(expectedIds.size);
      if (key !== 'alex') expect(list.data?.map((r) => r.call_id)).not.toContain(alexVoicemailCallId);
    }
    expect((await sessions.alex.client.rpc('list_voicemails', { p_limit: 100 })).data?.map((r) => r.call_id)).toContain(alexVoicemailCallId);
    const adminCount = await sessions.admin.client.rpc('unheard_voicemail_count');
    expect(adminCount.data).toBeGreaterThanOrEqual(2);
  });

  it('get_next_lead never suggests a lead the agent does not own, even when exhausted', async () => {
    for (const key of AGENTS) {
      const session = sessions[key];
      const own = new Set(await scopedLeadIds(session.userId));
      const exclude: string[] = [];
      for (let i = 0; i <= own.size; i += 1) {
        const { data, error } = await session.client.rpc('get_next_lead', { p_exclude_ids: exclude });
        expect(error).toBeNull();
        if (!data || data.length === 0) break;
        expect(data).toHaveLength(1);
        expect(own.has(data[0].lead_id), `${key} was offered ${data[0].lead_id}`).toBe(true);
        exclude.push(data[0].lead_id);
      }
      const { data } = await session.client.rpc('get_next_lead', { p_exclude_ids: exclude });
      expect(data).toEqual([]);
    }
  });
});

describe("B's calls, notes and voicemails", () => {
  it('allowed call columns: no rows for foreign leads or ids', async () => {
    expectEmptyRows(await alex.client.from('calls').select(ALLOWED_CALL_COLUMNS).in('lead_id', blairLeads.map((l) => l.id)));
    expectEmptyRows(await alex.client.from('calls').select(ALLOWED_CALL_COLUMNS).in('id', blairCallIds));
    expectEmptyRows(await alex.client.from('calls').select('id').eq('id', unmatchedVoicemailCallId));
    expectEmptyRows(await alex.client.from('calls').select('id').is('lead_id', null));
    const own = await alex.client.from('calls').select('id, lead_id').limit(1000);
    expect(own.error).toBeNull();
    expect(own.data?.length).toBeGreaterThan(0);
    for (const row of own.data ?? []) expect(alexLeadIds.has(row.lead_id ?? '')).toBe(true);
  });

  it("select('*') is refused, even for the agent's own calls", async () => {
    expectError(await alex.client.from('calls').select('*'), '42501');
    expectError(await alex.client.from('calls').select('*').eq('lead_id', [...alexLeadIds][0]), '42501');
  });

  it('hidden columns cannot be selected, aliased, filtered or ordered on, even for own calls', async () => {
    const ownLead = await seededLeadId('alex-06');
    for (const column of HIDDEN_CALL_COLUMNS) {
      expectError(await alex.client.from('calls').select(column).eq('lead_id', ownLead), '42501');
      expectError(await alex.client.from('calls').select(`id, x:${column}`).eq('lead_id', ownLead), '42501');
      expectError(await alex.client.from('calls').select('id').not(column, 'is', null), '42501');
      expectError(await alex.client.from('calls').select('id').order(column), '42501');
    }
    expectError(await alex.client.from('calls').select('id').eq('user_id', blair.userId), '42501');
    expectError(await alex.client.from('calls').select('id').eq('phone_number_id', await seededPhoneNumberId('blair')), '42501');
  });

  it("get_lead_call_history is empty for B's leads and random ids, and never names callers for agents", async () => {
    for (const lead of foreignToAlex) {
      expectEmptyRows(await alex.client.rpc('get_lead_call_history', { p_lead_id: lead.id }));
    }
    expectEmptyRows(await alex.client.rpc('get_lead_call_history', { p_lead_id: randomUUID() }));

    const own = await alex.client.rpc('get_lead_call_history', { p_lead_id: await seededLeadId('alex-06') });
    expect(own.error).toBeNull();
    expect(own.data?.length).toBe(3);
    for (const row of own.data ?? []) {
      expect(row.caller_name).toBeNull();
      expect(row.caller_id_e164).toBeNull();
    }
    // blair-06 has an earlier call made by Casey: Blair sees the history but not who called.
    const inherited = await blair.client.rpc('get_lead_call_history', { p_lead_id: await seededLeadId('blair-06') });
    expect(inherited.data?.length).toBe(2);
    expect(inherited.data?.filter((r) => !r.is_mine)).toHaveLength(1);
    for (const row of inherited.data ?? []) expect(row.caller_name).toBeNull();
  });

  it("get_voicemail_recording and mark_voicemail_heard refuse another agent's voicemail", async () => {
    for (const key of ['blair', 'casey'] as const) {
      const client = sessions[key].client;
      expectError(await client.rpc('get_voicemail_recording', { p_call_id: alexVoicemailCallId, p_user_id: sessions[key].userId }), '42501');
      const recording = await serviceClient().rpc('get_voicemail_recording', { p_call_id: alexVoicemailCallId, p_user_id: sessions[key].userId });
      expect(recording.error).toBeNull();
      expect(recording.data).toBeNull();
      const heard = await client.rpc('mark_voicemail_heard', { p_call_id: alexVoicemailCallId });
      expect(heard.error).toBeNull();
      expect(heard.data).toBe(false);
    }
    const { data } = await serviceClient().from('calls').select('handled_at').eq('id', alexVoicemailCallId).single();
    expect(data?.handled_at).toBeNull();
    // The owner's access resolves server-side (service role), but the SID never reaches the owner's own browser session.
    expect((await serviceClient().rpc('get_voicemail_recording', { p_call_id: alexVoicemailCallId, p_user_id: alex.userId })).data).toMatch(/^RE/);
    expectError(await alex.client.rpc('get_voicemail_recording', { p_call_id: alexVoicemailCallId, p_user_id: alex.userId }), '42501');
  });

  it('the admin-only unmatched voicemail is invisible to every agent', async () => {
    for (const key of AGENTS) {
      const client = sessions[key].client;
      expectError(await client.rpc('get_voicemail_recording', { p_call_id: unmatchedVoicemailCallId, p_user_id: sessions[key].userId }), '42501');
      expect((await serviceClient().rpc('get_voicemail_recording', { p_call_id: unmatchedVoicemailCallId, p_user_id: sessions[key].userId })).data).toBeNull();
      expect((await client.rpc('mark_voicemail_heard', { p_call_id: unmatchedVoicemailCallId })).data).toBe(false);
      expectEmptyRows(await client.from('calls').select('id').eq('id', unmatchedVoicemailCallId));
      expectEmptyRows(await client.rpc('get_lead_call_history', { p_lead_id: unmatchedVoicemailCallId }));
    }
    const { data } = await serviceClient().from('calls').select('handled_at').eq('id', unmatchedVoicemailCallId).single();
    expect(data?.handled_at).toBeNull();
    expect((await serviceClient().rpc('get_voicemail_recording', { p_call_id: unmatchedVoicemailCallId, p_user_id: sessions.admin.userId })).data).toMatch(/^RE/);
    const adminList = await sessions.admin.client.rpc('list_voicemails', { p_limit: 100 });
    expect(adminList.data?.map((r) => r.call_id)).toContain(unmatchedVoicemailCallId);
  });

  it("B's follow-ups are invisible", async () => {
    const { data: blairFollowUps } = await serviceClient().from('follow_ups').select('id').eq('user_id', blair.userId);
    expect(blairFollowUps?.length).toBeGreaterThan(0);
    expectEmptyRows(await alex.client.from('follow_ups').select('id, note, due_at').in('id', (blairFollowUps ?? []).map((f) => f.id)));
    expectEmptyRows(await alex.client.from('follow_ups').select('id').eq('user_id', blair.userId));
    expectEmptyRows(await alex.client.from('follow_ups').select('id').in('lead_id', foreignToAlex.map((l) => l.id)));
  });
});

describe('profiles, users, phone numbers and settings', () => {
  it('an agent reads exactly their own profile row', async () => {
    const all = await alex.client.from('profiles').select('id, email, name, role, active');
    expect(all.error).toBeNull();
    expect(all.data?.map((p) => p.id)).toEqual([alex.userId]);
    expectEmptyRows(await alex.client.from('profiles').select('id').eq('id', blair.userId));
    expectEmptyRows(await alex.client.from('profiles').select('id').neq('id', alex.userId));
    expectEmptyRows(await alex.client.from('profiles').select('id').eq('role', 'ADMIN'));
    expectEmptyRows(await alex.client.from('profiles').select('id').eq('active', false));
    const byDomain = await alex.client.from('profiles').select('id').ilike('email', '%funnelmcqueen%');
    expect(byDomain.data?.map((p) => p.id)).toEqual([alex.userId]);
  });

  it('an agent cannot list or read other users through the Auth admin API', async () => {
    const asAgent = clientWithAccessToken(alex.accessToken);
    const list = await asAgent.auth.admin.listUsers();
    expect(list.error).not.toBeNull();
    expect(list.data.users).toEqual([]);
    const other = await asAgent.auth.admin.getUserById(blair.userId);
    expect(other.error).not.toBeNull();
    expect(other.data.user).toBeNull();
  });

  it('phone_numbers are invisible, including the agent\'s own assigned number', async () => {
    expectEmptyRows(await alex.client.from('phone_numbers').select('id, e164'));
    expectEmptyRows(await alex.client.from('phone_numbers').select('id').eq('id', await seededPhoneNumberId('alex')));
    expectEmptyRows(await alex.client.from('phone_numbers').select('id').eq('id', await seededPhoneNumberId('pool')));
    expectEmptyRows(await alex.client.from('phone_numbers').select('id').eq('assigned_to', alex.userId));
  });

  it('settings rows are admin-only; the company name comes from get_company_name', async () => {
    expectEmptyRows(await alex.client.from('settings').select('id, company_name, voicemail_greeting'));
    const name = await alex.client.rpc('get_company_name');
    expect(name.error).toBeNull();
    expect(typeof name.data).toBe('string');
    expect((await alex.client.rpc('is_admin')).data).toBe(false);
  });
});

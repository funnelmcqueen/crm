// SPEC 13 "Admin can": read, modify, assign, reassign, delete, manage numbers, update settings and
// see caller names in history, all with the admin's own session (RLS applies, no service role).
import { beforeAll, describe, expect, it } from 'vitest';
import { SEED_LEADS, SEED_PHONE_NUMBERS } from '../../scripts/lib/seed-data';
import { serviceClient, signInAs, type SignedInUser } from '../helpers/clients';
import { createCall, createFollowUp, createLead, createPhoneNumber, createUser, fakeTwilioSid, fictionalPhone, type FixtureUser } from '../helpers/fixtures';
import { expectEmptyRows, expectError } from '../helpers/isolation';
import { seededLeadId, seededUserId, signInSeeded } from '../helpers/seeded';

let admin: SignedInUser;
let agent: FixtureUser;
let agentSession: SignedInUser;

beforeAll(async () => {
  admin = await signInSeeded('admin');
  agent = await createUser({ name: 'Admin Target Agent' });
  agentSession = await signInAs(agent.email, agent.password);
});

describe('admin access', () => {
  it('reads every lead, including other agents\', disabled agents\' and unassigned ones', async () => {
    const ids = await Promise.all(SEED_LEADS.map((l) => seededLeadId(l.ref)));
    const { data, error } = await admin.client.from('leads').select('id, assigned_to').in('id', ids);
    expect(error).toBeNull();
    expect(new Set(data?.map((l) => l.id))).toEqual(new Set(ids));
    expect(data?.filter((l) => l.assigned_to === null)).toHaveLength(5);

    const unassigned = await admin.client.rpc('search_leads', { p_unassigned: true, p_limit: 100 });
    expect(unassigned.error).toBeNull();
    for (const row of unassigned.data ?? []) expect(row.assigned_to).toBeNull();
    expect(unassigned.data?.map((r) => r.id)).toEqual(expect.arrayContaining(await Promise.all(['pool-01', 'pool-05'].map(seededLeadId))));

    const blairId = await seededUserId('blair');
    const byAgent = await admin.client.rpc('search_leads', { p_assigned_to: blairId, p_limit: 100 });
    expect(byAgent.data).toHaveLength(12);
  });

  it('updates any column and assigns a lead to an agent', async () => {
    const lead = await createLead({ status: 'NEW' });
    const phone = fictionalPhone();
    const updated = await admin.client
      .from('leads')
      .update({ business_name: 'Admin Renamed', phone, call_count: 7, source: 'Admin', assigned_to: agent.id })
      .eq('id', lead.id)
      .select('id, business_name, phone, call_count, source, assigned_to');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([{ id: lead.id, business_name: 'Admin Renamed', phone, call_count: 7, source: 'Admin', assigned_to: agent.id }]);
    expect((await agentSession.client.from('leads').select('id').eq('id', lead.id)).data).toEqual([{ id: lead.id }]);

    const unassigned = await admin.client.from('leads').update({ assigned_to: null }).eq('id', lead.id).select('assigned_to');
    expect(unassigned.data).toEqual([{ assigned_to: null }]);
    expectEmptyRows(await agentSession.client.from('leads').select('id').eq('id', lead.id));
  });

  it('inserts leads and reassigns them with reassign_leads', async () => {
    const inserted = await admin.client.from('leads').insert({ business_name: 'Admin Inserted', phone: fictionalPhone() }).select('id').single();
    expect(inserted.error).toBeNull();
    const id = inserted.data?.id ?? '';
    const count = await admin.client.rpc('reassign_leads', { p_lead_ids: [id], p_to_user_id: agent.id });
    expect(count.error).toBeNull();
    expect(count.data).toBe(1);
    expect((await agentSession.client.from('leads').select('id').eq('id', id)).data).toEqual([{ id }]);
  });

  it('deletes a lead, which cascades to its calls and follow-ups', async () => {
    const lead = await createLead({ assigned_to: agent.id });
    const call = await createCall({ lead_id: lead.id, user_id: agent.id, outcome: 'CONNECTED' });
    const followUp = await createFollowUp({ lead_id: lead.id, user_id: agent.id });
    const deleted = await admin.client.from('leads').delete().eq('id', lead.id).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([{ id: lead.id }]);
    const service = serviceClient();
    expect((await service.from('leads').select('id').eq('id', lead.id)).data).toEqual([]);
    expect((await service.from('calls').select('id').eq('id', call.id)).data).toEqual([]);
    expect((await service.from('follow_ups').select('id').eq('id', followUp.id)).data).toEqual([]);
  });

  it('reads and manages phone numbers', async () => {
    const seeded = await admin.client.from('phone_numbers').select('e164, assigned_to').in('e164', SEED_PHONE_NUMBERS.map((n) => n.e164));
    expect(seeded.error).toBeNull();
    expect(seeded.data).toHaveLength(3);

    const e164 = fictionalPhone();
    const inserted = await admin.client.from('phone_numbers').insert({ e164, twilio_sid: fakeTwilioSid('PN'), label: 'Admin added' }).select('id').single();
    expect(inserted.error).toBeNull();
    const id = inserted.data?.id ?? '';
    const assigned = await admin.client.from('phone_numbers').update({ assigned_to: agent.id, label: 'Assigned' }).eq('id', id).select('assigned_to, label');
    expect(assigned.data).toEqual([{ assigned_to: agent.id, label: 'Assigned' }]);
    const deactivated = await admin.client.from('phone_numbers').update({ active: false, assigned_to: null }).eq('id', id).select('active, assigned_to');
    expect(deactivated.data).toEqual([{ active: false, assigned_to: null }]);
    expectEmptyRows(await agentSession.client.from('phone_numbers').select('id').eq('id', id));
    const deleted = await admin.client.from('phone_numbers').delete().eq('id', id).select('id');
    expect(deleted.data).toEqual([{ id }]);
    expect((await serviceClient().from('phone_numbers').select('id').eq('id', id)).data).toEqual([]);
  });

  it('reads and updates settings', async () => {
    const current = await admin.client.from('settings').select('id, company_name').single();
    expect(current.error).toBeNull();
    const name = current.data?.company_name ?? '';
    // Writes the same value so parallel tests reading the company name are unaffected.
    const updated = await admin.client.from('settings').update({ company_name: name }).eq('id', true).select('company_name');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([{ company_name: name }]);
  });

  it('sees caller names in call history; the owning agent does not', async () => {
    const leadId = await seededLeadId('blair-06');
    const adminHistory = await admin.client.rpc('get_lead_call_history', { p_lead_id: leadId });
    expect(adminHistory.error).toBeNull();
    expect(new Set(adminHistory.data?.map((r) => r.caller_name))).toEqual(new Set(['Casey Morgan', 'Blair Chen']));
    const blair = await signInSeeded('blair');
    const agentHistory = await blair.client.rpc('get_lead_call_history', { p_lead_id: leadId });
    expect(agentHistory.data?.map((r) => r.caller_name)).toEqual([null, null]);
  });

  it('reads calls through allowed columns but, like agents, never the hidden columns directly', async () => {
    const leadId = await seededLeadId('casey-07');
    expect((await admin.client.from('calls').select('id, outcome').eq('lead_id', leadId)).data).toHaveLength(2);
    expectError(await admin.client.from('calls').select('user_id').eq('lead_id', leadId), '42501');
  });

  it('sees every voicemail, including the unmatched admin-only one', async () => {
    const list = await admin.client.rpc('list_voicemails', { p_limit: 100 });
    expect(list.error).toBeNull();
    expect(list.data?.some((r) => r.lead_id === null)).toBe(true);
    expect(list.data?.some((r) => r.business_name === SEED_LEADS.find((l) => l.ref === 'alex-06')?.businessName)).toBe(true);
  });

  it('exports all leads with the assigned agent column through GET /api/leads/export', async () => {
    const [{ handleLeadsExport }, { browserRequest, stubSessionEnv, unstubSessionEnv }, { leadE164 }, { default: Papa }] = await Promise.all([
      import('@/server/http/leads-export'),
      import('../routes/_helpers'),
      import('../../scripts/lib/seed-data'),
      import('papaparse'),
    ]);
    stubSessionEnv();
    try {
      const lead = await createLead({ assigned_to: agent.id });
      const unassigned = await createLead({ assigned_to: null });
      const res = await handleLeadsExport(browserRequest('/api/leads/export', { method: 'GET', token: admin.accessToken }));
      expect(res.status).toBe(200);
      const parsed = Papa.parse<Record<string, string>>((await res.text()).replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy' });
      expect(parsed.meta.fields?.at(-1)).toBe('Assigned agent');
      const byPhone = new Map(parsed.data.map((row) => [row.Phone, row]));
      for (const seeded of SEED_LEADS) expect(byPhone.has(leadE164(seeded))).toBe(true);
      const alexLead = SEED_LEADS.find((l) => l.ref === 'alex-01');
      expect(alexLead && byPhone.get(leadE164(alexLead))?.['Assigned agent']).toBe('Alex Rivera');
      expect(byPhone.get(lead.phone)?.['Assigned agent']).toBe('Admin Target Agent');
      expect(byPhone.get(unassigned.phone)?.['Assigned agent']).toBe('');
    } finally {
      unstubSessionEnv();
    }
  });
  it('views every user\'s stats through the admin dashboard RPCs (stage 6)', async () => {
    const statsAgent = await createUser({ name: 'Admin Stats Agent' });
    const lead = await createLead({ assigned_to: statsAgent.id });
    await createCall({ lead_id: lead.id, user_id: statsAgent.id, outcome: 'APPOINTMENT', duration_seconds: 42 });
    const rows = await admin.client.rpc('admin_agent_rows');
    expect(rows.error).toBeNull();
    const emails = new Set(rows.data?.map((r) => r.email));
    for (const email of ['alex@funnelmcqueen.test', 'blair@funnelmcqueen.test', 'casey@funnelmcqueen.test', 'dana@funnelmcqueen.test', statsAgent.email]) {
      expect(emails.has(email)).toBe(true);
    }
    expect(rows.data?.find((r) => r.user_id === statsAgent.id)).toMatchObject({ leads_assigned: 1, dials_today: 1, appointments_today: 1, talk_seconds_today: 42 });
    const totals = await admin.client.rpc('admin_team_totals');
    expect(totals.error).toBeNull();
    expect((totals.data as { calls_today: number }).calls_today).toBeGreaterThanOrEqual(1);
  });
  it('views all stats through the report RPCs (stage 10)', async () => {
    const reportAgent = await createUser({ name: 'Admin Report Agent' });
    const lead = await createLead({ assigned_to: reportAgent.id, status: 'CLIENT' });
    const number = await createPhoneNumber({ assigned_to: reportAgent.id });
    await createCall({
      lead_id: lead.id,
      user_id: reportAgent.id,
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      phone_number_id: number.id,
      call_status: 'completed',
      duration_seconds: 60,
      outcome: 'CONNECTED',
    });
    await createCall({ lead_id: lead.id, user_id: reportAgent.id, phone_number_id: number.id, outcome: 'NO_ANSWER' });
    const p_from = new Date(Date.now() - 3_600_000).toISOString();
    const p_to = new Date(Date.now() + 3_600_000).toISOString();

    const agents = await admin.client.rpc('admin_report_agents', { p_from, p_to });
    expect(agents.error).toBeNull();
    expect(agents.data?.find((r) => r.user_id === reportAgent.id)).toMatchObject({
      dials: 2,
      connected: 1,
      connect_rate: 0.5,
      talk_seconds: 60,
      avg_call_seconds: 60,
      clients: 1,
    });
    const numbers = await admin.client.rpc('admin_report_numbers', { p_from, p_to });
    expect(numbers.error).toBeNull();
    expect(numbers.data?.find((r) => r.phone_number_id === number.id)).toMatchObject({ dials: 2, answered: 1, answer_rate: 0.5 });
    const totals = await admin.client.rpc('admin_report_totals', { p_from, p_to });
    expect(totals.error).toBeNull();
    expect((totals.data as { dials: number }).dials).toBeGreaterThanOrEqual(2);
    const rows = await admin.client.rpc('admin_phone_number_rows');
    expect(rows.data?.find((r) => r.id === number.id)).toMatchObject({ assigned_name: 'Admin Report Agent', calls_today: 2 });
  });
});

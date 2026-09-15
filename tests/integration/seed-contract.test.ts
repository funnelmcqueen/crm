// SPEC 14 seed data, checked on the seeded stack through the service role (read-only). Other
// integration files add fixture users, leads, calls and numbers to the same stack concurrently, so
// every query is scoped to the rows the seed plan wrote.
import { beforeAll, describe, expect, it } from 'vitest';
import { SEED_LEADS, SEED_PHONE_NUMBERS, leadE164 } from '../../scripts/lib/seed-data';
import { serviceClient, trySignIn } from '../helpers/clients';
import { SEEDED_EMAILS, UNMATCHED_VOICEMAIL, seededUserId } from '../helpers/seeded';

const FICTIONAL_E164 = /^\+1[2-9]\d{2}55501\d{2}$/;
const ALL_STATUSES = ['NEW', 'TO_CALL', 'NO_ANSWER', 'VOICEMAIL', 'CONNECTED', 'INTERESTED', 'FOLLOW_UP', 'APPOINTMENT', 'PROPOSAL', 'CLIENT', 'NOT_INTERESTED', 'DO_NOT_CONTACT'];
const SEED_LEAD_PHONES = SEED_LEADS.map((lead) => leadE164(lead));

type Ids = Record<'admin' | 'alex' | 'blair' | 'casey' | 'dana', string>;
let ids: Ids;
let seededLeadIds: string[];

beforeAll(async () => {
  ids = {
    admin: await seededUserId('admin'),
    alex: await seededUserId('alex'),
    blair: await seededUserId('blair'),
    casey: await seededUserId('casey'),
    dana: await seededUserId('dana'),
  };
  const { data, error } = await serviceClient().from('leads').select('id').in('phone', SEED_LEAD_PHONES);
  if (error) throw new Error(`cannot load seeded leads: ${error.message}`);
  seededLeadIds = (data ?? []).map((lead) => lead.id);
});

describe('seed data (SPEC 14)', () => {
  it('has 1 admin, 3 active agents and 1 disabled agent who is also banned in Auth', async () => {
    const { data, error } = await serviceClient()
      .from('profiles')
      .select('id, email, role, active')
      .in('email', Object.values(SEEDED_EMAILS));
    expect(error).toBeNull();
    const byId = new Map((data ?? []).map((p) => [p.id, p]));
    expect(byId.get(ids.admin)).toMatchObject({ role: 'ADMIN', active: true });
    for (const key of ['alex', 'blair', 'casey'] as const) expect(byId.get(ids[key])).toMatchObject({ role: 'AGENT', active: true });
    expect(byId.get(ids.dana)).toMatchObject({ role: 'AGENT', active: false });

    const { data: auth, error: authError } = await serviceClient().auth.admin.getUserById(ids.dana);
    expect(authError).toBeNull();
    expect(new Date(auth.user?.banned_until ?? 0).getTime()).toBeGreaterThan(Date.now());
    expect((await trySignIn(SEEDED_EMAILS.dana)).user).toBeNull();
  });

  it('has 40 leads spread across agents plus 5 unassigned, all with fictional 555-01xx phones and every status', async () => {
    const { data, error } = await serviceClient().from('leads').select('id, phone, assigned_to, status').in('id', seededLeadIds);
    expect(error).toBeNull();
    const leads = data ?? [];
    expect(leads).toHaveLength(SEED_LEAD_PHONES.length);
    const perOwner = new Map<string | null, number>();
    for (const lead of leads) perOwner.set(lead.assigned_to, (perOwner.get(lead.assigned_to) ?? 0) + 1);
    expect(Object.fromEntries([...perOwner].map(([owner, n]) => [owner ?? 'unassigned', n]))).toEqual({
      [ids.alex]: 12,
      [ids.blair]: 12,
      [ids.casey]: 12,
      [ids.dana]: 4,
      unassigned: 5,
    });
    expect(leads.filter((l) => !FICTIONAL_E164.test(l.phone))).toEqual([]);
    expect(new Set(leads.map((l) => l.status))).toEqual(new Set(ALL_STATUSES));
  });

  it('has 3 fictional Twilio numbers: one for Alex, one for Blair, one in the pool', async () => {
    const { data, error } = await serviceClient()
      .from('phone_numbers')
      .select('e164, assigned_to, active')
      .in('e164', SEED_PHONE_NUMBERS.map((n) => n.e164));
    expect(error).toBeNull();
    const numbers = data ?? [];
    expect(numbers).toHaveLength(3);
    expect(numbers.every((n) => FICTIONAL_E164.test(n.e164) && n.active)).toBe(true);
    expect(numbers.map((n) => n.assigned_to ?? 'pool').sort()).toEqual([ids.alex, ids.blair, 'pool'].sort());
  });

  it('has outbound and inbound call history, a couple of voicemails and overdue follow-ups', async () => {
    const { data: calls, error } = await serviceClient()
      .from('calls')
      .select('direction, mode, lead_id, user_id, voicemail_recording_sid')
      .in('lead_id', seededLeadIds);
    expect(error).toBeNull();
    const rows = calls ?? [];
    expect(new Set(rows.map((c) => c.direction))).toEqual(new Set(['OUTBOUND', 'INBOUND']));
    expect(new Set(rows.map((c) => c.mode))).toEqual(new Set(['IN_APP', 'TEL']));
    expect(rows.filter((c) => c.voicemail_recording_sid !== null)).toHaveLength(1);

    const { data: unmatched, error: unmatchedError } = await serviceClient()
      .from('calls')
      .select('lead_id, user_id, direction, voicemail_recording_sid')
      .eq('remote_e164', UNMATCHED_VOICEMAIL.remoteE164)
      .is('lead_id', null);
    expect(unmatchedError).toBeNull();
    expect(unmatched).toHaveLength(1);
    expect(unmatched?.[0]).toMatchObject({ user_id: null, direction: 'INBOUND' });
    expect(unmatched?.[0]?.voicemail_recording_sid).not.toBeNull();

    const { data: followUps, error: followUpError } = await serviceClient()
      .from('follow_ups')
      .select('due_at')
      .in('lead_id', seededLeadIds)
      .is('completed_at', null);
    expect(followUpError).toBeNull();
    const now = Date.now();
    expect((followUps ?? []).some((f) => new Date(f.due_at).getTime() < now)).toBe(true);
    expect((followUps ?? []).some((f) => new Date(f.due_at).getTime() > now)).toBe(true);
  });

  it('keeps every seeded lead consistent: next_follow_up_at is the earliest open follow-up of its owner, call_count matches logged calls', async () => {
    const [leads, followUps, calls] = await Promise.all([
      serviceClient().from('leads').select('id, assigned_to, next_follow_up_at, call_count').in('id', seededLeadIds),
      serviceClient().from('follow_ups').select('lead_id, user_id, due_at').in('lead_id', seededLeadIds).is('completed_at', null),
      serviceClient().from('calls').select('lead_id, outcome').in('lead_id', seededLeadIds).not('outcome', 'is', null),
    ]);
    expect([leads.error, followUps.error, calls.error]).toEqual([null, null, null]);
    expect(leads.data).toHaveLength(SEED_LEAD_PHONES.length);
    for (const lead of leads.data ?? []) {
      const open = (followUps.data ?? []).filter((f) => f.lead_id === lead.id);
      expect(open.every((f) => f.user_id === lead.assigned_to)).toBe(true);
      const earliest = open.map((f) => new Date(f.due_at).getTime()).sort((a, b) => a - b)[0];
      expect(lead.next_follow_up_at === null ? undefined : new Date(lead.next_follow_up_at).getTime()).toBe(earliest);
      expect(lead.call_count).toBe((calls.data ?? []).filter((c) => c.lead_id === lead.id).length);
    }
  });
});

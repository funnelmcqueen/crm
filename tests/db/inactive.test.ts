// A disabled user with a still-valid JWT gets zero rows from every table and RPC, whether agent or admin.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  bootDb,
  createAuthUser,
  createCallRow,
  createFollowUpRow,
  createLeadRow,
  createPhoneNumberRow,
  fakeTwilioSid,
  insertRow,
  pgError,
  serviceRows,
  userRows,
  type PGlite,
} from '../helpers/pglite';

let db: PGlite;
const ids = { agent: '', admin: '', lead: '', call: '', voicemail: '', unmatched: '' };

beforeAll(async () => {
  db = await bootDb();
  // Created active so every row exists, then disabled (like an admin disabling an agent).
  ids.agent = await createAuthUser(db);
  ids.admin = await createAuthUser(db, { role: 'ADMIN' });
  ids.lead = (await createLeadRow(db, { assigned_to: ids.agent, source: 'Yelp' })).id;
  await createLeadRow(db, { source: 'Referral' });
  await createPhoneNumberRow(db, { assigned_to: ids.agent });
  ids.call = (await createCallRow(db, { lead_id: ids.lead, user_id: ids.agent, outcome: 'CONNECTED' })).id;
  ids.voicemail = (
    await createCallRow(db, {
      lead_id: ids.lead,
      user_id: ids.agent,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      voicemail_recording_sid: fakeTwilioSid('RE'),
    })
  ).id;
  ids.unmatched = (
    await createCallRow(db, {
      lead_id: null,
      user_id: ids.agent,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      voicemail_recording_sid: fakeTwilioSid('RE'),
    })
  ).id;
  await createFollowUpRow(db, { lead_id: ids.lead, user_id: ids.agent, due_at: new Date(Date.now() - 3_600_000) });
  await insertRow(db, 'rate_limit_hits', { user_id: ids.agent, bucket: 'voice_token' });
  await db.query('update public.profiles set active = false where id = any($1::uuid[])', [[ids.agent, ids.admin]]);
});

afterAll(async () => {
  await db?.close();
});

describe.each([
  ['inactive agent', 'agent'],
  ['inactive admin', 'admin'],
] as const)('%s', (_label, key) => {
  const uid = () => ids[key];

  it.each([
    'select id from public.profiles',
    'select id from public.leads',
    'select id from public.calls',
    'select id from public.follow_ups',
    'select id from public.phone_numbers',
    'select id from public.settings',
    'select * from public.get_next_lead()',
    'select * from public.search_leads()',
    'select * from public.list_lead_sources()',
    `select * from public.get_lead_call_history('${'00000000-0000-0000-0000-000000000000'}')`,
    'select * from public.list_voicemails()',
  ])('gets zero rows: %s', async (sql) => {
    expect(await userRows(db, uid(), sql)).toEqual([]);
  });

  it('gets zero rows from call history and voicemail RPCs for rows it used to own', async () => {
    expect(await userRows(db, uid(), 'select * from public.get_lead_call_history($1)', [ids.lead])).toEqual([]);
    expect(await userRows(db, uid(), 'select public.unheard_voicemail_count() as n')).toEqual([{ n: 0 }]);
    expect(await serviceRows(db, 'select public.get_voicemail_recording($1, $2) as sid', [ids.voicemail, uid()])).toEqual([{ sid: null }]);
    expect(await serviceRows(db, 'select public.get_voicemail_recording($1, $2) as sid', [ids.unmatched, uid()])).toEqual([{ sid: null }]);
    expect(await userRows(db, uid(), 'select public.mark_voicemail_heard($1) as ok', [ids.voicemail])).toEqual([{ ok: false }]);
    expect(await userRows(db, uid(), 'select public.can_access_lead($1) as ok, public.is_admin() as admin, public.is_active_user() as active', [ids.lead])).toEqual([
      { ok: false, admin: false, active: false },
    ]);
  });

  it.each([
    [`select public.log_call('CONNECTED', p_lead_id => $1)`, [() => ids.lead]],
    [`select public.log_call('CONNECTED', p_call_id => $1)`, [() => ids.call]],
    ['select public.create_outbound_call($1)', [() => ids.lead]],
    ['select public.reassign_leads(array[$1::uuid], null)', [() => ids.lead]],
    ['select public.touch_device_presence()', []],
    [`select public.consume_rate_limit('voice_token')`, []],
  ] as Array<[string, Array<() => string>]>)('is refused with 42501: %s', async (sql, params) => {
    expect((await pgError(userRows(db, uid(), sql, params.map((p) => p())))).code).toBe('42501');
  });

  it('cannot write through the tables', async () => {
    expect(await userRows(db, uid(), `update public.leads set notes = 'x' where id = $1 returning id`, [ids.lead])).toEqual([]);
    expect(await userRows(db, uid(), `update public.profiles set name = 'x' where id = $1 returning id`, [uid()])).toEqual([]);
    const err = await pgError(
      userRows(db, uid(), `insert into public.follow_ups (lead_id, user_id, due_at) values ($1, $2, now())`, [ids.lead, uid()]),
    );
    expect(err.code).toBe('42501');
  });

  it('left the data untouched', async () => {
    expect(await adminSqlRows(db, 'select notes, call_count from public.leads where id = $1', [ids.lead])).toEqual([{ notes: null, call_count: 0 }]);
    expect(await adminSqlRows(db, 'select handled_at from public.calls where id = $1', [ids.voicemail])).toEqual([{ handled_at: null }]);
  });
});

// Row level security and table/column privileges on every table, as agent A vs agent B vs admin vs
// inactive user vs anon vs service_role.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  anonRows,
  bootDb,
  createAuthUser,
  createCallRow,
  createFollowUpRow,
  createLeadRow,
  createPhoneNumberRow,
  fakeTwilioSid,
  insertRow,
  nextPhone,
  pgError,
  serviceRows,
  userRows,
  type PGlite,
} from '../helpers/pglite';

let db: PGlite;

const u = { admin: '', a: '', b: '', inactive: '' };
const lead = { a: '', b: '', unassigned: '', inactive: '' };
const call = { a: '', b: '', inboundA: '', adminVoicemail: '', inactive: '' };
const fu = { a: '', b: '', stale: '', inactive: '' };
const num = { a: '', pool: '' };

type IdRow = { id: string };
const sortedIds = (rows: IdRow[]): string[] => rows.map((r) => r.id).sort();

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN', name: 'Admin' });
  u.a = await createAuthUser(db, { name: 'Agent A' });
  u.b = await createAuthUser(db, { name: 'Agent B' });
  u.inactive = await createAuthUser(db, { name: 'Inactive', active: false });

  lead.a = (await createLeadRow(db, { assigned_to: u.a, business_name: 'Alpha Plumbing', notes: 'A private' })).id;
  lead.b = (await createLeadRow(db, { assigned_to: u.b, business_name: 'Bravo Dental', notes: 'B private' })).id;
  lead.unassigned = (await createLeadRow(db, { business_name: 'Unassigned Co' })).id;
  lead.inactive = (await createLeadRow(db, { assigned_to: u.inactive, business_name: 'Inactive Owned' })).id;

  num.a = (await createPhoneNumberRow(db, { assigned_to: u.a, label: 'A direct' })).id;
  num.pool = (await createPhoneNumberRow(db, { label: 'Pool' })).id;

  call.a = (
    await createCallRow(db, {
      lead_id: lead.a,
      user_id: u.a,
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      phone_number_id: num.a,
      outcome: 'CONNECTED',
      notes: 'A call note',
    })
  ).id;
  call.b = (await createCallRow(db, { lead_id: lead.b, user_id: u.b, outcome: 'NO_ANSWER', notes: 'B call note' })).id;
  call.inboundA = (
    await createCallRow(db, {
      lead_id: null,
      user_id: u.a,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      remote_e164: nextPhone(),
      phone_number_id: num.a,
    })
  ).id;
  call.adminVoicemail = (
    await createCallRow(db, {
      lead_id: null,
      user_id: null,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      remote_e164: nextPhone(),
      phone_number_id: num.pool,
      voicemail_recording_sid: fakeTwilioSid('RE'),
      voicemail_duration_seconds: 12,
    })
  ).id;
  call.inactive = (await createCallRow(db, { lead_id: lead.inactive, user_id: u.inactive, outcome: 'CONNECTED' })).id;

  fu.a = (await createFollowUpRow(db, { lead_id: lead.a, user_id: u.a })).id;
  fu.b = (await createFollowUpRow(db, { lead_id: lead.b, user_id: u.b })).id;
  // Left behind by an unassign: B's follow-up on A's lead. Neither agent may see it.
  fu.stale = (await createFollowUpRow(db, { lead_id: lead.a, user_id: u.b })).id;
  fu.inactive = (await createFollowUpRow(db, { lead_id: lead.inactive, user_id: u.inactive })).id;

  await insertRow(db, 'rate_limit_hits', { user_id: u.a, bucket: 'voice_token' });
});

afterAll(async () => {
  await db?.close();
});

describe('leads', () => {
  it('agents see only leads currently assigned to them; admin sees all; inactive sees none', async () => {
    expect(sortedIds(await userRows<IdRow>(db, u.a, 'select id from public.leads'))).toEqual([lead.a]);
    expect(sortedIds(await userRows<IdRow>(db, u.b, 'select id from public.leads'))).toEqual([lead.b]);
    expect(sortedIds(await userRows<IdRow>(db, u.admin, 'select id from public.leads'))).toEqual(
      [lead.a, lead.b, lead.unassigned, lead.inactive].sort(),
    );
    expect(await userRows(db, u.inactive, 'select id from public.leads')).toEqual([]);
  });

  it("an agent cannot read another agent's or an unassigned lead by id, count or ilike", async () => {
    expect(await userRows(db, u.a, 'select id, notes from public.leads where id = $1', [lead.b])).toEqual([]);
    expect(await userRows(db, u.a, 'select id from public.leads where id = $1', [lead.unassigned])).toEqual([]);
    expect(await userRows(db, u.a, `select id from public.leads where business_name ilike '%bravo%'`)).toEqual([]);
    expect(await userRows(db, u.a, 'select count(*)::int as n from public.leads')).toEqual([{ n: 1 }]);
  });

  it("an agent cannot update or delete another agent's lead", async () => {
    expect(await userRows(db, u.a, `update public.leads set notes = 'pwned' where id = $1 returning id`, [lead.b])).toEqual([]);
    expect(await userRows(db, u.a, 'delete from public.leads where id = $1 returning id', [lead.b])).toEqual([]);
    expect(await adminSqlRows(db, 'select notes from public.leads where id = $1', [lead.b])).toEqual([{ notes: 'B private' }]);
  });

  it('an agent cannot insert leads or delete their own lead', async () => {
    const err = await pgError(
      userRows(db, u.a, `insert into public.leads (business_name, phone, assigned_to) values ('Mine', $1, $2)`, [nextPhone(), u.a]),
    );
    expect(err.code).toBe('42501');
    expect(await userRows(db, u.a, 'delete from public.leads where id = $1 returning id', [lead.a])).toEqual([]);
    expect(await adminSqlRows(db, 'select id from public.leads where id = $1', [lead.a])).toHaveLength(1);
  });

  it('an agent cannot change assigned_to, even on their own lead', async () => {
    for (const target of [u.b, null]) {
      const err = await pgError(userRows(db, u.a, 'update public.leads set assigned_to = $2 where id = $1', [lead.a, target]));
      expect(err.code).toBe('42501');
    }
    expect(await adminSqlRows(db, 'select assigned_to from public.leads where id = $1', [lead.a])).toEqual([{ assigned_to: u.a }]);
  });

  it('admin can insert and hard-delete a lead', async () => {
    const [row] = await userRows<IdRow>(
      db,
      u.admin,
      `insert into public.leads (business_name, phone) values ('Admin Made', $1) returning id`,
      [nextPhone()],
    );
    expect(await userRows(db, u.admin, 'delete from public.leads where id = $1 returning id', [row.id])).toEqual([{ id: row.id }]);
  });

  it('service_role bypasses RLS', async () => {
    expect(await serviceRows(db, 'select count(*)::int as n from public.leads')).toEqual([{ n: 4 }]);
  });
});

describe('calls', () => {
  const visible = 'select id from public.calls';

  it('agents see calls on their assigned leads and their own unmatched inbound calls only', async () => {
    expect(sortedIds(await userRows<IdRow>(db, u.a, visible))).toEqual([call.a, call.inboundA].sort());
    expect(sortedIds(await userRows<IdRow>(db, u.b, visible))).toEqual([call.b]);
    expect(await userRows(db, u.inactive, visible)).toEqual([]);
    expect(sortedIds(await userRows<IdRow>(db, u.admin, visible))).toEqual(
      [call.a, call.b, call.inboundA, call.adminVoicemail, call.inactive].sort(),
    );
  });

  it.each(['*', 'user_id', 'phone_number_id', 'provider_call_sid', 'voicemail_recording_sid'])(
    'column grants deny `select %s` for agents and admins',
    async (column) => {
      for (const userId of [u.a, u.admin]) {
        expect((await pgError(userRows(db, userId, `select ${column} from public.calls`))).code).toBe('42501');
      }
    },
  );

  it.each(['user_id', 'provider_call_sid', 'voicemail_recording_sid', 'phone_number_id'])(
    'hidden column %s cannot be used as a filter oracle',
    async (column) => {
      const err = await pgError(userRows(db, u.a, `select id from public.calls where ${column} is not null`));
      expect(err.code).toBe('42501');
    },
  );

  it('the granted columns are readable', async () => {
    const rows = await userRows<{ id: string; notes: string }>(
      db,
      u.a,
      `select id, created_at, lead_id, direction, mode, remote_e164, call_status, outcome, notes,
              duration_seconds, voicemail_duration_seconds, handled_at
         from public.calls where id = $1`,
      [call.a],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].notes).toBe('A call note');
  });

  it('agents cannot insert, update or delete calls, even on their own lead', async () => {
    const insert = await pgError(
      userRows(db, u.a, `insert into public.calls (lead_id, user_id, direction, mode, outcome) values ($1, $2, 'OUTBOUND', 'TEL', 'CONNECTED')`, [
        lead.a,
        u.a,
      ]),
    );
    expect(insert.code).toBe('42501');
    expect(await userRows(db, u.a, `update public.calls set outcome = 'APPOINTMENT' where id = $1 returning id`, [call.a])).toEqual([]);
    expect(await userRows(db, u.a, 'delete from public.calls where id = $1 returning id', [call.a])).toEqual([]);
    expect(await userRows(db, u.a, `update public.calls set notes = 'x' where id = $1 returning id`, [call.b])).toEqual([]);
    expect(await adminSqlRows(db, 'select outcome, notes from public.calls where id = $1', [call.a])).toEqual([
      { outcome: 'CONNECTED', notes: 'A call note' },
    ]);
  });

  it('admin can update a call', async () => {
    expect(await userRows(db, u.admin, `update public.calls set notes = 'admin edit' where id = $1 returning id`, [call.b])).toEqual([
      { id: call.b },
    ]);
  });
});

describe('follow_ups', () => {
  const visible = 'select id from public.follow_ups';

  it('agents see only their own follow-ups on leads assigned to them', async () => {
    expect(sortedIds(await userRows<IdRow>(db, u.a, visible))).toEqual([fu.a]);
    expect(sortedIds(await userRows<IdRow>(db, u.b, visible))).toEqual([fu.b]);
    expect(await userRows(db, u.inactive, visible)).toEqual([]);
    expect(sortedIds(await userRows<IdRow>(db, u.admin, visible))).toEqual([fu.a, fu.b, fu.stale, fu.inactive].sort());
  });

  it("an agent cannot create a follow-up on a lead they don't own, or for someone else", async () => {
    const cases: Array<[string, string]> = [
      [lead.b, u.a],
      [lead.b, u.b],
      [lead.a, u.b],
      [lead.unassigned, u.a],
    ];
    for (const [leadId, userId] of cases) {
      const err = await pgError(
        userRows(db, u.a, `insert into public.follow_ups (lead_id, user_id, due_at) values ($1, $2, now() + interval '1 day')`, [
          leadId,
          userId,
        ]),
      );
      expect(err.code).toBe('42501');
    }
  });

  it('an agent can create, reschedule and complete their own follow-up', async () => {
    const [row] = await userRows<IdRow>(
      db,
      u.a,
      `insert into public.follow_ups (lead_id, user_id, due_at, note) values ($1, $2, now() + interval '2 days', 'mine') returning id`,
      [lead.a, u.a],
    );
    expect(
      await userRows(db, u.a, `update public.follow_ups set due_at = now() + interval '3 days' where id = $1 returning id`, [row.id]),
    ).toEqual([{ id: row.id }]);
    expect(await userRows(db, u.a, 'update public.follow_ups set completed_at = now() where id = $1 returning id', [row.id])).toEqual([
      { id: row.id },
    ]);
  });

  it("an agent cannot update or delete another agent's follow-up, or move their own", async () => {
    expect(await userRows(db, u.a, `update public.follow_ups set note = 'x' where id = $1 returning id`, [fu.b])).toEqual([]);
    expect(await userRows(db, u.a, 'delete from public.follow_ups where id = $1 returning id', [fu.b])).toEqual([]);
    expect(await userRows(db, u.a, 'delete from public.follow_ups where id = $1 returning id', [fu.stale])).toEqual([]);
    for (const [column, value] of [
      ['user_id', u.b],
      ['lead_id', lead.b],
    ] as const) {
      const err = await pgError(userRows(db, u.a, `update public.follow_ups set ${column} = $2 where id = $1`, [fu.a, value]));
      expect(err.code).toBe('42501');
    }
    expect(await adminSqlRows(db, 'select count(*)::int as n from public.follow_ups where id = any($1::uuid[])', [[fu.b, fu.stale]])).toEqual([
      { n: 2 },
    ]);
  });
});

describe('profiles', () => {
  it('agents read only their own profile; admin reads all; inactive reads none', async () => {
    expect(sortedIds(await userRows<IdRow>(db, u.a, 'select id from public.profiles'))).toEqual([u.a]);
    expect(await userRows(db, u.a, 'select id, email from public.profiles where id = $1', [u.b])).toEqual([]);
    expect(await userRows(db, u.inactive, 'select id from public.profiles')).toEqual([]);
    expect(sortedIds(await userRows<IdRow>(db, u.admin, 'select id from public.profiles'))).toEqual([u.admin, u.a, u.b, u.inactive].sort());
  });

  it("an agent cannot update another profile, insert or delete profiles", async () => {
    expect(await userRows(db, u.a, `update public.profiles set name = 'x' where id = $1 returning id`, [u.b])).toEqual([]);
    expect(await userRows(db, u.a, 'delete from public.profiles where id = $1 returning id', [u.a])).toEqual([]);
    const err = await pgError(userRows(db, u.a, `insert into public.profiles (id, email) values (gen_random_uuid(), 'x@y.test')`));
    expect(err.code).toBe('42501');
  });
});

describe('phone_numbers', () => {
  it('agents have no access at all; admin has full access', async () => {
    expect(await userRows(db, u.a, 'select id from public.phone_numbers')).toEqual([]);
    expect(await userRows(db, u.a, `update public.phone_numbers set label = 'x' where id = $1 returning id`, [num.a])).toEqual([]);
    const err = await pgError(
      userRows(db, u.a, `insert into public.phone_numbers (e164, twilio_sid) values ($1, $2)`, [nextPhone(), fakeTwilioSid('PN')]),
    );
    expect(err.code).toBe('42501');
    expect(sortedIds(await userRows<IdRow>(db, u.admin, 'select id from public.phone_numbers'))).toEqual([num.a, num.pool].sort());
    expect(await userRows(db, u.inactive, 'select id from public.phone_numbers')).toEqual([]);
  });
});

describe('settings', () => {
  it('only admins read or write the settings row; everyone gets the company name through the RPC', async () => {
    expect(await userRows(db, u.a, 'select company_name from public.settings')).toEqual([]);
    expect(await userRows(db, u.a, `update public.settings set company_name = 'x' returning id`)).toEqual([]);
    expect(await userRows(db, u.admin, 'select company_name from public.settings')).toEqual([{ company_name: 'Funnel McQueen' }]);
    expect(await userRows(db, u.a, 'select public.get_company_name() as name')).toEqual([{ name: 'Funnel McQueen' }]);
    expect(await anonRows(db, 'select public.get_company_name() as name')).toEqual([{ name: 'Funnel McQueen' }]);
  });
});

describe('rate_limit_hits', () => {
  it('is not readable or writable by any API role except service_role', async () => {
    for (const userId of [u.a, u.admin]) {
      expect((await pgError(userRows(db, userId, 'select id from public.rate_limit_hits'))).code).toBe('42501');
      expect(
        (await pgError(userRows(db, userId, `insert into public.rate_limit_hits (user_id, bucket) values ($1, 'x')`, [userId]))).code,
      ).toBe('42501');
    }
    expect((await pgError(anonRows(db, 'select id from public.rate_limit_hits'))).code).toBe('42501');
    expect(await serviceRows(db, 'select count(*)::int as n from public.rate_limit_hits')).toEqual([{ n: 1 }]);
  });
});

describe('anon and table-level privileges', () => {
  it.each(['profiles', 'settings', 'leads', 'phone_numbers', 'calls', 'follow_ups', 'rate_limit_hits'])(
    'anon has no privileges on %s',
    async (table) => {
      expect((await pgError(anonRows(db, `select 1 from public.${table} limit 1`))).code).toBe('42501');
    },
  );

  it('anon cannot write leads', async () => {
    const err = await pgError(anonRows(db, `insert into public.leads (business_name, phone) values ('x', $1)`, [nextPhone()]));
    expect(err.code).toBe('42501');
  });

  it.each(['leads', 'calls', 'follow_ups', 'profiles'])('authenticated cannot TRUNCATE %s (RLS does not cover it)', async (table) => {
    expect((await pgError(userRows(db, u.admin, `truncate public.${table} cascade`))).code).toBe('42501');
  });

  it('every public table has RLS enabled', async () => {
    const rows = await adminSqlRows<{ relname: string; relrowsecurity: boolean }>(
      db,
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(7);
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it('public views, if any, are security_invoker', async () => {
    const rows = await adminSqlRows<{ relname: string; reloptions: string[] | null }>(
      db,
      `select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('v', 'm')`,
    );
    for (const row of rows) expect(row.reloptions ?? []).toContain('security_invoker=true');
  });
});

// SPEC 4 and 5 structure checked against the catalog: enums, columns, indexes, FK delete rules,
// integrity constraints and helper function attributes. Behavior lives in the other db suites.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSqlRows, bootDb, createAuthUser, createCallRow, createLeadRow, pgError, type PGlite } from '../helpers/pglite';

let db: PGlite;

beforeAll(async () => {
  db = await bootDb();
});

afterAll(async () => {
  await db.close();
});

describe('enums (SPEC 4)', () => {
  it.each([
    ['user_role', ['ADMIN', 'AGENT']],
    [
      'lead_status',
      ['NEW', 'TO_CALL', 'NO_ANSWER', 'VOICEMAIL', 'CONNECTED', 'INTERESTED', 'FOLLOW_UP', 'APPOINTMENT', 'PROPOSAL', 'CLIENT', 'NOT_INTERESTED', 'DO_NOT_CONTACT'],
    ],
    ['call_outcome', ['NO_ANSWER', 'VOICEMAIL', 'CONNECTED', 'INTERESTED', 'FOLLOW_UP', 'APPOINTMENT', 'NOT_INTERESTED', 'WRONG_NUMBER']],
    ['call_direction', ['OUTBOUND', 'INBOUND']],
    ['call_mode', ['IN_APP', 'TEL']],
  ])('public.%s has exactly the specified labels in order', async (name, labels) => {
    const rows = await adminSqlRows<{ label: string }>(db, `select e.enumlabel as label
         from pg_catalog.pg_enum e
         join pg_catalog.pg_type t on t.oid = e.enumtypid
         join pg_catalog.pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' and t.typname = $1
        order by e.enumsortorder`,
      [name],
    );
    expect(rows.map((r) => r.label)).toEqual(labels);
  });
});

describe('columns (SPEC 4)', () => {
  const SPEC_COLUMNS: Record<string, Record<string, string>> = {
    profiles: {
      id: 'uuid', email: 'text', name: 'text', role: 'user_role', active: 'boolean', daily_call_target: 'integer',
      timezone: 'text', in_app_calling_enabled: 'boolean', created_at: 'timestamp with time zone',
    },
    settings: { company_name: 'text', default_daily_target: 'integer', default_timezone: 'text', voicemail_greeting: 'text' },
    leads: {
      id: 'uuid', created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone', business_name: 'text',
      contact_name: 'text', phone: 'text', phone_raw: 'text', email: 'text', website: 'text', website_domain: 'text',
      address: 'text', city: 'text', state: 'text', country: 'text', source: 'text', status: 'lead_status', notes: 'text',
      assigned_to: 'uuid', last_contacted_at: 'timestamp with time zone', next_follow_up_at: 'timestamp with time zone',
      call_count: 'integer',
    },
    phone_numbers: {
      id: 'uuid', e164: 'text', twilio_sid: 'text', label: 'text', active: 'boolean', assigned_to: 'uuid',
      last_used_at: 'timestamp with time zone', created_at: 'timestamp with time zone',
    },
    calls: {
      id: 'uuid', created_at: 'timestamp with time zone', lead_id: 'uuid', user_id: 'uuid', direction: 'call_direction',
      mode: 'call_mode', phone_number_id: 'uuid', provider_call_sid: 'text', call_status: 'text', outcome: 'call_outcome',
      notes: 'text', duration_seconds: 'integer', voicemail_recording_sid: 'text', voicemail_duration_seconds: 'integer',
      handled_at: 'timestamp with time zone',
    },
    follow_ups: {
      id: 'uuid', lead_id: 'uuid', user_id: 'uuid', created_at: 'timestamp with time zone', due_at: 'timestamp with time zone',
      completed_at: 'timestamp with time zone', note: 'text',
    },
  };

  it.each(Object.keys(SPEC_COLUMNS))('%s has every specified column with the specified type', async (table) => {
    const rows = await adminSqlRows<{ column_name: string; type: string }>(db, `select column_name, case when data_type = 'USER-DEFINED' then udt_name else data_type end as type
         from information_schema.columns
        where table_schema = 'public' and table_name = $1`,
      [table],
    );
    const actual = Object.fromEntries(rows.map((r) => [r.column_name, r.type]));
    for (const [column, type] of Object.entries(SPEC_COLUMNS[table])) {
      expect({ table, column, type: actual[column] }).toEqual({ table, column, type });
    }
  });

  it('applies the specified defaults', async () => {
    const [profile] = await adminSqlRows<{ daily_call_target: number; timezone: string; in_app_calling_enabled: boolean; role: string; active: boolean }>(db, `select daily_call_target, timezone, in_app_calling_enabled, role, active from public.profiles where id = $1`,
      [await createAuthUser(db)],
    );
    expect(profile).toEqual({ daily_call_target: 50, timezone: 'America/New_York', in_app_calling_enabled: true, role: 'AGENT', active: true });

    const lead = await createLeadRow(db);
    expect(lead.status).toBe('NEW');
    expect(lead.call_count).toBe(0);
    expect(lead.assigned_to).toBeNull();
  });
});

describe('indexes (SPEC 4)', () => {
  let defs: string[] = [];

  beforeAll(async () => {
    defs = (await adminSqlRows<{ indexdef: string }>(db, `select indexdef from pg_catalog.pg_indexes where schemaname = 'public'`)).map((r) => r.indexdef);
  });

  it.each([
    ['leads (assigned_to, status)', /ON public\.leads USING btree \(assigned_to, status\)$/],
    ['leads (assigned_to, next_follow_up_at)', /ON public\.leads USING btree \(assigned_to, next_follow_up_at\)$/],
    ['leads (assigned_to, last_contacted_at)', /ON public\.leads USING btree \(assigned_to, last_contacted_at\)$/],
    ['leads (phone)', /ON public\.leads USING btree \(phone\)$/],
    ['leads (website_domain)', /ON public\.leads USING btree \(website_domain\)$/],
    ['leads trgm business_name', /ON public\.leads USING gin \(business_name extensions\.gin_trgm_ops\)$/],
    ['leads trgm contact_name', /ON public\.leads USING gin \(contact_name extensions\.gin_trgm_ops\)$/],
    ['leads trgm email', /ON public\.leads USING gin \(email extensions\.gin_trgm_ops\)$/],
    ['leads trgm website', /ON public\.leads USING gin \(website extensions\.gin_trgm_ops\)$/],
    ['leads trgm city', /ON public\.leads USING gin \(city extensions\.gin_trgm_ops\)$/],
    ['calls (user_id, created_at)', /ON public\.calls USING btree \(user_id, created_at\)$/],
    ['calls (lead_id, created_at)', /ON public\.calls USING btree \(lead_id, created_at\)$/],
    ['calls unique (provider_call_sid)', /^CREATE UNIQUE INDEX \S+ ON public\.calls USING btree \(provider_call_sid\)$/],
    ['follow_ups (user_id, due_at) where open', /ON public\.follow_ups USING btree \(user_id, due_at\) WHERE \(completed_at IS NULL\)$/],
    ['phone_numbers (assigned_to)', /ON public\.phone_numbers USING btree \(assigned_to\)$/],
    ['phone_numbers unique (e164)', /^CREATE UNIQUE INDEX \S+ ON public\.phone_numbers USING btree \(e164\)$/],
    ['phone_numbers unique (twilio_sid)', /^CREATE UNIQUE INDEX \S+ ON public\.phone_numbers USING btree \(twilio_sid\)$/],
  ])('%s exists', (_label, pattern) => {
    expect(defs.some((def) => pattern.test(def))).toBe(true);
  });
});

describe('foreign keys (SPEC 4: profiles RESTRICT, lead deletion cascades)', () => {
  it('has exactly the specified delete rules', async () => {
    const rows = await adminSqlRows<{ fk: string; rule: string }>(db, `select format('%s.%s.%s -> %s.%s', sn.nspname, sc.relname, a.attname, tn.nspname, tc.relname) as fk,
              c.confdeltype::text as rule
         from pg_catalog.pg_constraint c
         join pg_catalog.pg_class sc on sc.oid = c.conrelid
         join pg_catalog.pg_namespace sn on sn.oid = sc.relnamespace
         join pg_catalog.pg_class tc on tc.oid = c.confrelid
         join pg_catalog.pg_namespace tn on tn.oid = tc.relnamespace
         join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and sn.nspname = 'public'
        order by 1`,
    );
    // r = RESTRICT, c = CASCADE
    expect(Object.fromEntries(rows.map((r) => [r.fk, r.rule]))).toEqual({
      'public.calls.lead_id -> public.leads': 'c',
      'public.calls.phone_number_id -> public.phone_numbers': 'r',
      'public.calls.user_id -> public.profiles': 'r',
      'public.follow_ups.lead_id -> public.leads': 'c',
      'public.follow_ups.user_id -> public.profiles': 'r',
      'public.leads.assigned_to -> public.profiles': 'r',
      'public.phone_numbers.assigned_to -> public.profiles': 'r',
      'public.profiles.id -> auth.users': 'r',
    });
  });

  // 23001 restrict_violation: ON DELETE RESTRICT fails immediately, unlike NO ACTION (23503).
  it('an agent with data cannot be deleted, at the profile or the auth user level', async () => {
    const agent = await createAuthUser(db);
    const lead = await createLeadRow(db, { assigned_to: agent });
    await createCallRow(db, { lead_id: lead.id, user_id: agent, outcome: 'CONNECTED' });
    expect((await pgError(db.query(`delete from public.profiles where id = $1`, [agent]))).code).toBe('23001');
    expect((await pgError(db.query(`delete from auth.users where id = $1`, [agent]))).code).toBe('23001');
    const [left] = await adminSqlRows<{ n: number }>(db, `select count(*)::int as n from public.calls where user_id = $1`, [agent]);
    expect(left.n).toBe(1);
  });
});

describe('integrity constraints and triggers', () => {
  it('leads.updated_at is maintained by a trigger', async () => {
    const lead = await createLeadRow(db, { created_at: '2000-01-01T00:00:00Z', updated_at: '2000-01-01T00:00:00Z' });
    const [before] = await adminSqlRows<{ updated_at: Date }>(db, `select updated_at from public.leads where id = $1`, [lead.id]);
    expect(before.updated_at.toISOString()).toBe('2000-01-01T00:00:00.000Z');
    await db.query(`update public.leads set notes = 'touched', updated_at = '2001-01-01' where id = $1`, [lead.id]);
    const [after] = await adminSqlRows<{ updated_at: Date }>(db, `select updated_at from public.leads where id = $1`, [lead.id]);
    expect(after.updated_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('settings holds a single row', async () => {
    const [count] = await adminSqlRows<{ n: number }>(db, `select count(*)::int as n from public.settings`);
    expect(count.n).toBe(1);
    expect((await pgError(db.query(`insert into public.settings (id) values (false)`))).code).toBe('23514');
    expect((await pgError(db.query(`insert into public.settings (id) values (true)`))).code).toBe('23505');
  });

  it('rejects non-E.164 lead phones, unknown call statuses, and outbound calls without an owner and lead', async () => {
    expect((await pgError(createLeadRow(db, { phone: '212-555-0100' }))).code).toBe('23514');
    const agent = await createAuthUser(db);
    const lead = await createLeadRow(db, { assigned_to: agent });
    expect((await pgError(createCallRow(db, { lead_id: lead.id, user_id: agent, call_status: 'answered' }))).code).toBe('23514');
    expect((await pgError(createCallRow(db, { lead_id: lead.id, user_id: null }))).code).toBe('23514');
    expect((await pgError(createCallRow(db, { lead_id: null, user_id: agent }))).code).toBe('23514');
    expect((await pgError(createCallRow(db, { lead_id: lead.id, user_id: agent, mode: 'TEL', provider_call_sid: 'CA123' }))).code).toBe('23514');
  });
});

describe('RLS helper functions (SPEC 5)', () => {
  it('is_admin and is_active_user are SECURITY DEFINER, STABLE and pin search_path to empty', async () => {
    const rows = await adminSqlRows<{ proname: string; prosecdef: boolean; provolatile: string; proconfig: string[] | null }>(db, `select p.proname, p.prosecdef, p.provolatile::text as provolatile, p.proconfig
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('is_admin', 'is_active_user')
        order by p.proname`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect({ name: row.proname, definer: row.prosecdef, volatility: row.provolatile }).toEqual({ name: row.proname, definer: true, volatility: 's' });
      expect(row.proconfig ?? []).toContain('search_path=""');
    }
  });

  it('is_admin is false for an inactive admin, and is_active_user tracks the active flag', async () => {
    const admin = await createAuthUser(db, { role: 'ADMIN' });
    const check = async () =>
      (
        await db.transaction(async (tx) => {
          await tx.exec(`set local role authenticated`);
          await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: admin, role: 'authenticated' })]);
          return (await tx.query<{ admin: boolean; active: boolean }>(`select public.is_admin() as admin, public.is_active_user() as active`)).rows[0];
        })
      );
    expect(await check()).toEqual({ admin: true, active: true });
    await db.query(`update public.profiles set active = false where id = $1`, [admin]);
    expect(await check()).toEqual({ admin: false, active: false });
  });
});

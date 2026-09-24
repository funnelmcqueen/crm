// Column rules enforced by triggers: profiles_guard, leads_guard, follow_ups_guard, the auth.users
// triggers and the derived leads.next_follow_up_at.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  bootDb,
  createAuthUser,
  createFollowUpRow,
  createLeadRow,
  nextPhone,
  pgError,
  serviceRows,
  userRows,
  type PGlite,
} from '../helpers/pglite';

let db: PGlite;
const u = { admin: '', a: '', b: '' };

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN', name: 'Admin' });
  u.a = await createAuthUser(db, { name: 'Agent A' });
  u.b = await createAuthUser(db, { name: 'Agent B' });
});

afterAll(async () => {
  await db?.close();
});

async function profile(id: string): Promise<Record<string, unknown>> {
  const [row] = await adminSqlRows<Record<string, unknown>>(db, 'select * from public.profiles where id = $1', [id]);
  return row;
}

describe('profiles_guard', () => {
  it('an agent may change their own name', async () => {
    expect(await userRows(db, u.a, `update public.profiles set name = 'Alex R.' where id = $1 returning name`, [u.a])).toEqual([
      { name: 'Alex R.' },
    ]);
  });

  it('only an admin may change a profile primary locale', async () => {
    expect((await pgError(userRows(db, u.a, `update public.profiles set primary_locale = 'de' where id = $1`, [u.a]))).code).toBe('42501');
    await userRows(db, u.admin, `update public.profiles set primary_locale = 'de' where id = $1`, [u.b]);
    expect(await profile(u.b)).toMatchObject({ primary_locale: 'de' });
    await userRows(db, u.a, `update public.profiles set primary_locale = 'en' where id = $1`, [u.b]);
    expect(await profile(u.b)).toMatchObject({ primary_locale: 'de' });
  });

  it('rejects unsupported primary locales', async () => {
    expect((await pgError(userRows(db, u.admin, `update public.profiles set primary_locale = 'fr' where id = $1`, [u.b]))).code).toBe('23514');
  });

  it.each<[string, unknown]>([
    ['role', 'ADMIN'],
    ['active', false],
    ['daily_call_target', 5],
    ['in_app_calling_enabled', false],
    ['timezone', 'Europe/London'],
    ['email', 'new@example.test'],
    ['device_seen_at', new Date()],
    ['created_at', new Date(0)],
  ])('an agent cannot change their own %s', async (column, value) => {
    const before = await profile(u.a);
    const err = await pgError(userRows(db, u.a, `update public.profiles set ${column} = $2 where id = $1`, [u.a, value]));
    expect(err.code).toBe('42501');
    expect(await profile(u.a)).toEqual(before);
  });

  it('an admin cannot change their own role or active flag (lockout guard)', async () => {
    for (const [column, value] of [
      ['role', 'AGENT'],
      ['active', false],
    ] as const) {
      const err = await pgError(userRows(db, u.admin, `update public.profiles set ${column} = $2 where id = $1`, [u.admin, value]));
      expect(err.code).toBe('42501');
    }
    expect(await profile(u.admin)).toMatchObject({ role: 'ADMIN', active: true });
  });

  it("an admin can change an agent's role, flags, target and timezone but not email", async () => {
    const rows = await userRows(
      db,
      u.admin,
      `update public.profiles
          set daily_call_target = 70, in_app_calling_enabled = false, timezone = 'America/Chicago', name = 'Blair'
        where id = $1 returning daily_call_target, in_app_calling_enabled, timezone`,
      [u.b],
    );
    expect(rows).toEqual([{ daily_call_target: 70, in_app_calling_enabled: false, timezone: 'America/Chicago' }]);
    const err = await pgError(userRows(db, u.admin, `update public.profiles set email = 'x@y.test' where id = $1`, [u.b]));
    expect(err.code).toBe('42501');
  });

  it('validates timezone and name length', async () => {
    expect((await pgError(userRows(db, u.admin, `update public.profiles set timezone = 'Mars/Olympus' where id = $1`, [u.b]))).code).toBe(
      '22023',
    );
    expect((await pgError(userRows(db, u.a, 'update public.profiles set name = $2 where id = $1', [u.a, 'x'.repeat(201)]))).code).toBe(
      '23514',
    );
  });
});

describe('auth.users triggers', () => {
  it('new users always become active AGENTs, ignoring a role in user metadata', async () => {
    await db.query(`update public.settings set default_daily_target = 42, default_timezone = 'America/Denver'`);
    try {
      const id = crypto.randomUUID();
      await db.query(
        `insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
         values ($1, 'authenticated', 'authenticated', 'pat@example.test', '{"name":"  Pat  ","role":"ADMIN"}', now(), now())`,
        [id],
      );
      expect(await profile(id)).toMatchObject({
        email: 'pat@example.test',
        name: 'Pat',
        role: 'AGENT',
        active: true,
        daily_call_target: 42,
        timezone: 'America/Denver',
      });

      const bare = crypto.randomUUID();
      await db.query(
        `insert into auth.users (id, aud, role, email, created_at, updated_at) values ($1, 'authenticated', 'authenticated', 'jo.smith@example.test', now(), now())`,
        [bare],
      );
      expect(await profile(bare)).toMatchObject({ name: 'jo.smith', role: 'AGENT' });

      await db.query(`update auth.users set email = 'jo.new@example.test' where id = $1`, [bare]);
      expect(await profile(bare)).toMatchObject({ email: 'jo.new@example.test' });
    } finally {
      await db.query(`update public.settings set default_daily_target = 50, default_timezone = 'America/New_York'`);
    }
  });
});

describe('leads_guard', () => {
  it('an agent may change status and notes on their own lead', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const rows = await userRows(
      db,
      u.a,
      `update public.leads set status = 'INTERESTED', notes = 'Call back Friday' where id = $1 returning status, notes`,
      [lead.id],
    );
    expect(rows).toEqual([{ status: 'INTERESTED', notes: 'Call back Friday' }]);
  });

  it.each<[string, () => unknown]>([
    ['business_name', () => 'Renamed'],
    ['contact_name', () => 'Someone'],
    ['phone', () => nextPhone()],
    ['phone_raw', () => '(999) 555-0100'],
    ['email', () => 'x@y.test'],
    ['website', () => 'https://x.test'],
    ['website_domain', () => 'x.test'],
    ['address', () => '1 Main St'],
    ['city', () => 'Elsewhere'],
    ['state', () => 'ZZ'],
    ['country', () => 'CA'],
    ['source', () => 'Hacked'],
    ['assigned_to', () => u.b],
    ['last_contacted_at', () => new Date()],
    ['call_count', () => 99],
    ['created_at', () => new Date(0)],
    ['id', () => crypto.randomUUID()],
  ])('an agent cannot change %s on their own lead', async (column, value) => {
    const lead = await createLeadRow(db, { assigned_to: u.a, source: 'Yelp' });
    const [before] = await adminSqlRows(db, 'select * from public.leads where id = $1', [lead.id]);
    const err = await pgError(userRows(db, u.a, `update public.leads set ${column} = $2 where id = $1`, [lead.id, value()]));
    expect(err.code).toBe('42501');
    expect((await adminSqlRows(db, 'select * from public.leads where id = $1', [lead.id]))[0]).toEqual(before);
  });

  it('a direct write to next_follow_up_at is ignored for agents and admins (always derived)', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const due = new Date(Date.now() + 3 * 86_400_000);
    await createFollowUpRow(db, { lead_id: lead.id, user_id: u.a, due_at: due });

    for (const userId of [u.a, u.admin]) {
      const rows = await userRows<{ next_follow_up_at: Date }>(
        db,
        userId,
        `update public.leads set next_follow_up_at = now() + interval '100 days' where id = $1 returning next_follow_up_at`,
        [lead.id],
      );
      expect(rows[0].next_follow_up_at.getTime()).toBe(due.getTime());
    }
    const cleared = await userRows<{ next_follow_up_at: Date }>(
      db,
      u.admin,
      'update public.leads set next_follow_up_at = null where id = $1 returning next_follow_up_at',
      [lead.id],
    );
    expect(cleared[0].next_follow_up_at.getTime()).toBe(due.getTime());
  });

  it('service_role writes are recomputed from open follow-ups', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const rows = await serviceRows<{ next_follow_up_at: Date | null }>(
      db,
      `update public.leads set next_follow_up_at = now() where id = $1 returning next_follow_up_at`,
      [lead.id],
    );
    expect(rows[0].next_follow_up_at).toBeNull();
  });

  it('an insert never sets next_follow_up_at, even by an admin', async () => {
    const rows = await userRows<{ next_follow_up_at: Date | null }>(
      db,
      u.admin,
      `insert into public.leads (business_name, phone, next_follow_up_at) values ('New', $1, now()) returning next_follow_up_at`,
      [nextPhone()],
    );
    expect(rows[0].next_follow_up_at).toBeNull();
  });

  it('next_follow_up_at tracks the earliest open follow-up through insert, complete and delete', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const next = async (): Promise<number | null> => {
      const [row] = await adminSqlRows<{ next_follow_up_at: Date | null }>(db, 'select next_follow_up_at from public.leads where id = $1', [
        lead.id,
      ]);
      return row.next_follow_up_at?.getTime() ?? null;
    };
    const later = new Date(Date.now() + 5 * 86_400_000);
    const sooner = new Date(Date.now() + 1 * 86_400_000);

    const [laterFu] = await userRows<{ id: string }>(
      db,
      u.a,
      'insert into public.follow_ups (lead_id, user_id, due_at) values ($1, $2, $3) returning id',
      [lead.id, u.a, later],
    );
    expect(await next()).toBe(later.getTime());
    const [soonerFu] = await userRows<{ id: string }>(
      db,
      u.a,
      'insert into public.follow_ups (lead_id, user_id, due_at) values ($1, $2, $3) returning id',
      [lead.id, u.a, sooner],
    );
    expect(await next()).toBe(sooner.getTime());
    await userRows(db, u.a, 'update public.follow_ups set completed_at = now() where id = $1', [soonerFu.id]);
    expect(await next()).toBe(later.getTime());
    await userRows(db, u.a, 'delete from public.follow_ups where id = $1', [laterFu.id]);
    expect(await next()).toBeNull();
  });
});

describe('follow_ups_guard', () => {
  it('an agent may reschedule, annotate and complete their own follow-up', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const fu = await createFollowUpRow(db, { lead_id: lead.id, user_id: u.a });
    const rows = await userRows(
      db,
      u.a,
      `update public.follow_ups set due_at = now() + interval '2 days', note = 'moved', completed_at = now() where id = $1 returning note`,
      [fu.id],
    );
    expect(rows).toEqual([{ note: 'moved' }]);
  });

  it.each<[string, (ctx: { otherLead: string }) => unknown]>([
    ['lead_id', ({ otherLead }) => otherLead],
    ['user_id', () => u.b],
    ['created_at', () => new Date(0)],
    ['id', () => crypto.randomUUID()],
  ])('an agent cannot change %s, even to another lead they own', async (column, value) => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const otherLead = await createLeadRow(db, { assigned_to: u.a });
    const fu = await createFollowUpRow(db, { lead_id: lead.id, user_id: u.a });
    const err = await pgError(
      userRows(db, u.a, `update public.follow_ups set ${column} = $2 where id = $1`, [fu.id, value({ otherLead: otherLead.id })]),
    );
    expect(err.code).toBe('42501');
  });

  it('an admin may move a follow-up', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const fu = await createFollowUpRow(db, { lead_id: lead.id, user_id: u.a });
    expect(await userRows(db, u.admin, 'update public.follow_ups set user_id = $2 where id = $1 returning user_id', [fu.id, u.b])).toEqual([
      { user_id: u.b },
    ]);
  });
});

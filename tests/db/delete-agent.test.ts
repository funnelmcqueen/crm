// Admin "Delete agent" (migration 20260915001400_delete_agent.sql, docs/DEVIATIONS.md D40): admin only, only
// agents with no leads and no open follow-ups, history kept, and a deleted profile is frozen and never owns work
// again. The FOR UPDATE / FOR KEY SHARE locking that serializes a delete against a concurrent assignment needs two
// connections, which single-connection PGlite cannot provide; these tests pin the rule each side enforces.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  fakeTwilioSid,
  anonRows,
  bootDb,
  createAuthUser,
  createCallRow,
  createFollowUpRow,
  createLeadRow,
  createPhoneNumberRow,
  pgError,
  serviceRows,
  userRows,
  type PGlite,
} from '../helpers/pglite';

type Json = Record<string, unknown>;

let db: PGlite;
const u = { admin: '', otherAdmin: '', disabledAdmin: '', agent: '', owner: '' };

async function deleteAs(caller: string, target: string): Promise<Json> {
  const [row] = await userRows<{ j: Json }>(db, caller, 'select public.admin_delete_agent($1::uuid) as j', [target]);
  return row.j;
}

async function checkAs(caller: string, target: string): Promise<Json> {
  const [row] = await userRows<{ j: Json }>(db, caller, 'select public.admin_agent_delete_check($1::uuid) as j', [target]);
  return row.j;
}

async function profile(id: string) {
  const [row] = await adminSqlRows<{ active: boolean; deleted_at: Date | null; name: string; role: string }>(
    db,
    'select active, deleted_at, name, role from public.profiles where id = $1',
    [id],
  );
  return row;
}

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN', name: 'Delete Admin' });
  u.otherAdmin = await createAuthUser(db, { role: 'ADMIN', name: 'Other Admin' });
  u.disabledAdmin = await createAuthUser(db, { role: 'ADMIN', active: false });
  u.agent = await createAuthUser(db, { name: 'Plain Agent' });
  u.owner = await createAuthUser(db, { name: 'Lead Owner' });
});

afterAll(async () => {
  await db?.close();
});

describe('who may delete', () => {
  it('only an active admin can call admin_delete_agent or admin_agent_delete_check', async () => {
    const target = await createAuthUser(db, { name: 'Untouchable' });
    for (const caller of [u.agent, u.disabledAdmin]) {
      expect((await pgError(deleteAs(caller, target))).code).toBe('42501');
      expect((await pgError(checkAs(caller, target))).code).toBe('42501');
    }
    expect((await pgError(anonRows(db, 'select public.admin_delete_agent($1::uuid)', [target]))).code).toBe('42501');
    expect((await pgError(serviceRows(db, 'select public.admin_delete_agent($1::uuid)', [target]))).code).toBe('42501');
    expect(await profile(target)).toMatchObject({ active: true, deleted_at: null, name: 'Untouchable' });
  });

  it("refuses admins and the caller's own account, and the check says why", async () => {
    expect((await pgError(deleteAs(u.admin, u.otherAdmin))).code).toBe('42501');
    expect((await pgError(deleteAs(u.admin, u.admin))).code).toBe('42501');
    expect(await checkAs(u.admin, u.otherAdmin)).toMatchObject({ reason: 'admin', deletable: false });
    expect(await checkAs(u.admin, u.admin)).toMatchObject({ reason: 'self', deletable: false });
    expect(await profile(u.otherAdmin)).toMatchObject({ active: true, deleted_at: null });
  });

  it('answers unknown ids with not_found', async () => {
    const unknown = randomUUID();
    expect((await pgError(deleteAs(u.admin, unknown))).code).toBe('P0002');
    expect((await pgError(checkAs(u.admin, unknown))).code).toBe('P0002');
  });
});

describe('what blocks a delete', () => {
  it('an assigned lead blocks it, and nothing changes', async () => {
    const target = await createAuthUser(db, { name: 'Has Leads' });
    await createLeadRow(db, { assigned_to: target });
    await createLeadRow(db, { assigned_to: target });
    expect(await checkAs(u.admin, target)).toMatchObject({ leads: 2, open_follow_ups: 0, reason: 'has_work', deletable: false });
    expect(await pgError(deleteAs(u.admin, target))).toEqual({ code: 'P0001', message: 'agent_has_work' });
    expect(await profile(target)).toMatchObject({ active: true, deleted_at: null, name: 'Has Leads' });
  });

  it('an open follow-up blocks it even without leads', async () => {
    const target = await createAuthUser(db, { name: 'Has Follow-up' });
    const lead = await createLeadRow(db, { assigned_to: u.owner });
    await createFollowUpRow(db, { lead_id: lead.id, user_id: target });
    expect(await checkAs(u.admin, target)).toMatchObject({ leads: 0, open_follow_ups: 1, reason: 'has_work', deletable: false });
    expect((await pgError(deleteAs(u.admin, target))).message).toBe('agent_has_work');
  });

  it('past calls and completed follow-ups do not block it', async () => {
    const target = await createAuthUser(db, { name: 'History Only' });
    const lead = await createLeadRow(db, { assigned_to: u.owner });
    await createCallRow(db, { lead_id: lead.id, user_id: target, outcome: 'CONNECTED', duration_seconds: 90 });
    await createFollowUpRow(db, { lead_id: lead.id, user_id: target, completed_at: new Date() });
    expect(await checkAs(u.admin, target)).toMatchObject({
      leads: 0,
      open_follow_ups: 0,
      calls: 1,
      completed_follow_ups: 1,
      reason: null,
      deletable: true,
    });
  });
});

describe('deleting', () => {
  it('marks the profile deleted, keeps history, unassigns phone numbers and labels the name', async () => {
    const target = await createAuthUser(db, { name: 'Sam Stone' });
    const lead = await createLeadRow(db, { assigned_to: u.owner });
    const call = await createCallRow(db, { lead_id: lead.id, user_id: target, outcome: 'INTERESTED', duration_seconds: 120 });
    const done = await createFollowUpRow(db, { lead_id: lead.id, user_id: target, completed_at: new Date() });
    const number = await createPhoneNumberRow(db, { assigned_to: target });

    expect(await deleteAs(u.admin, target)).toEqual({ user_id: target, already_deleted: false, phone_numbers_unassigned: 1 });

    const after = await profile(target);
    expect(after.active).toBe(false);
    expect(after.deleted_at).toBeInstanceOf(Date);
    expect(after.name).toBe('Sam Stone (deleted)');

    const [kept] = await adminSqlRows<{ calls: number; done: number; numbers: number }>(
      db,
      `select (select count(*)::int from public.calls where id = $1 and user_id = $2) as calls,
              (select count(*)::int from public.follow_ups where id = $3 and user_id = $2) as done,
              (select count(*)::int from public.phone_numbers where id = $4 and assigned_to is null) as numbers`,
      [call.id, target, done.id, number.id],
    );
    expect(kept).toEqual({ calls: 1, done: 1, numbers: 1 });

    // Reports keep their row, labelled.
    const report = await userRows<{ user_id: string; name: string; dials: number }>(
      db,
      u.admin,
      `select user_id, name, dials::int as dials from public.admin_report_agents(now() - interval '1 day', now() + interval '1 day')`,
    );
    expect(report.find((row) => row.user_id === target)).toEqual({ user_id: target, name: 'Sam Stone (deleted)', dials: 1 });
  });

  it('is idempotent and never doubles the name label', async () => {
    const target = await createAuthUser(db, { name: 'Twice Deleted' });
    await deleteAs(u.admin, target);
    expect(await deleteAs(u.admin, target)).toEqual({ user_id: target, already_deleted: true, phone_numbers_unassigned: 0 });
    expect((await profile(target)).name).toBe('Twice Deleted (deleted)');
    expect(await checkAs(u.admin, target)).toMatchObject({ deleted: true, reason: 'deleted', deletable: false });
  });

  it('labels a profile with an empty name as a deleted agent', async () => {
    const target = await createAuthUser(db, { name: 'Placeholder' });
    await adminSqlRows(db, `update public.profiles set name = '' where id = $1`, [target]);
    await deleteAs(u.admin, target);
    expect((await profile(target)).name).toBe('Deleted agent');
  });

  it('keeps deleted agents in admin_agent_rows, flagged, so team totals still count their calls', async () => {
    const target = await createAuthUser(db, { name: 'Flagged Agent' });
    await deleteAs(u.admin, target);
    const rows = await userRows<{ user_id: string; deleted: boolean; active: boolean }>(
      db,
      u.admin,
      'select user_id, deleted, active from public.admin_agent_rows()',
    );
    expect(rows.find((row) => row.user_id === target)).toEqual({ user_id: target, deleted: true, active: false });
    expect(rows.find((row) => row.user_id === u.agent)).toEqual({ user_id: u.agent, deleted: false, active: true });
  });
});

describe('a deleted profile', () => {
  let deleted = '';
  let completedFollowUp = '';

  beforeAll(async () => {
    deleted = await createAuthUser(db, { name: 'Frozen Agent' });
    const lead = await createLeadRow(db, { assigned_to: u.owner });
    completedFollowUp = (await createFollowUpRow(db, { lead_id: lead.id, user_id: deleted, completed_at: new Date() })).id;
    await deleteAs(u.admin, deleted);
  });

  it('is frozen for admins: no reactivation, no edits, no undelete', async () => {
    for (const statement of [
      'update public.profiles set active = true where id = $1',
      `update public.profiles set name = 'Back Again' where id = $1`,
      'update public.profiles set deleted_at = null where id = $1',
      `update public.profiles set role = 'ADMIN' where id = $1`,
    ]) {
      expect((await pgError(userRows(db, u.admin, statement, [deleted]))).code, statement).toBe('42501');
    }
    expect(await profile(deleted)).toMatchObject({ active: false, name: 'Frozen Agent (deleted)', role: 'AGENT' });
  });

  it('is frozen for the service role and postgres too, except for the email Auth copies in', async () => {
    for (const statement of [
      'update public.profiles set deleted_at = null, active = true where id = $1',
      `update public.profiles set role = 'ADMIN' where id = $1`,
      `update public.profiles set name = 'Back Again' where id = $1`,
    ]) {
      expect((await pgError(serviceRows(db, statement, [deleted]))).code, statement).toBe('42501');
      expect((await pgError(adminSqlRows(db, statement, [deleted]))).code, statement).toBe('42501');
    }
    // Closing the login moves the Auth email; on_auth_user_email_changed copies it into the profile.
    const moved = `deleted-${deleted}@deleted.invalid`;
    await adminSqlRows(db, 'update auth.users set email = $2 where id = $1', [deleted, moved]);
    const [row] = await adminSqlRows<{ email: string }>(db, 'select email from public.profiles where id = $1', [deleted]);
    expect(row.email).toBe(moved);
    expect(await checkAs(u.admin, deleted)).toMatchObject({ deleted: true, email: moved, reason: 'deleted' });
    // An API caller still cannot touch the email.
    const apiEmail = await pgError(userRows(db, u.admin, `update public.profiles set email = 'x@example.test' where id = $1`, [deleted]));
    expect(apiEmail.code).toBe('42501');
  });

  it('can never be active again, even with triggers off', async () => {
    const error = await pgError(
      db.transaction(async (tx) => {
        await tx.exec('set local session_replication_role = replica');
        await tx.query('update public.profiles set active = true where id = $1', [deleted]);
      }),
    );
    expect(error.code).toBe('23514');
  });

  it('never owns leads, follow-ups or phone numbers again', async () => {
    expect((await pgError(createLeadRow(db, { assigned_to: deleted }))).code).toBe('22023');
    const lead = await createLeadRow(db, { assigned_to: u.owner });
    expect((await pgError(adminSqlRows(db, 'update public.leads set assigned_to = $1 where id = $2', [deleted, lead.id]))).code).toBe(
      '22023',
    );
    expect((await pgError(createFollowUpRow(db, { lead_id: lead.id, user_id: deleted }))).code).toBe('22023');
    // Reopening their completed follow-up would hand them open work too; other edits to it are fine.
    expect(
      (await pgError(adminSqlRows(db, 'update public.follow_ups set completed_at = null where id = $1', [completedFollowUp]))).code,
    ).toBe('22023');
    await adminSqlRows(db, `update public.follow_ups set note = 'kept for the record' where id = $1`, [completedFollowUp]);
    expect(await checkAs(u.admin, deleted)).toMatchObject({ open_follow_ups: 0, completed_follow_ups: 1 });
    const number = await createPhoneNumberRow(db);
    expect(
      (await pgError(adminSqlRows(db, 'update public.phone_numbers set assigned_to = $1 where id = $2', [deleted, number.id]))).code,
    ).toBe('22023');
    expect(
      (await pgError(userRows(db, u.admin, 'select public.reassign_leads(array[$1]::uuid[], $2::uuid)', [lead.id, deleted]))).code,
    ).toBe('22023');

    // Unassigning, and assigning to a live agent, still work.
    await adminSqlRows(db, 'update public.leads set assigned_to = null where id = $1', [lead.id]);
    await adminSqlRows(db, 'update public.leads set assigned_to = $1 where id = $2', [u.agent, lead.id]);
    const [row] = await adminSqlRows<{ assigned_to: string }>(db, 'select assigned_to from public.leads where id = $1', [lead.id]);
    expect(row.assigned_to).toBe(u.agent);
  });

  it('leaves no voicemail stranded: an admin can mark one routed to them heard', async () => {
    const inbound = (userId: string) =>
      createCallRow(db, {
        lead_id: null,
        user_id: userId,
        direction: 'INBOUND',
        mode: 'IN_APP',
        provider_call_sid: fakeTwilioSid('CA'),
        voicemail_recording_sid: fakeTwilioSid('RE'),
        voicemail_duration_seconds: 12,
      });
    const stranded = await inbound(deleted);
    const live = await inbound(u.agent);
    for (const id of [stranded.id, live.id]) {
      const [row] = await userRows<{ ok: boolean }>(db, u.admin, 'select public.mark_voicemail_heard($1::uuid) as ok', [id]);
      expect(row.ok).toBe(true);
    }
    const handled = await adminSqlRows<{ id: string; handled_at: Date | null }>(
      db,
      'select id, handled_at from public.calls where id = any($1::uuid[])',
      [[stranded.id, live.id]],
    );
    expect(handled.find((r) => r.id === stranded.id)?.handled_at).not.toBeNull();
    // A live agent's voicemail is still theirs to handle.
    expect(handled.find((r) => r.id === live.id)?.handled_at).toBeNull();
  });

  it('gets a report row only for a range in which they made calls', async () => {
    const range = (from: Date, to: Date) => [from.toISOString(), to.toISOString()];
    const reportIds = async (from: Date, to: Date) =>
      (
        await userRows<{ user_id: string }>(
          db,
          u.admin,
          'select user_id from public.admin_report_agents($1::timestamptz, $2::timestamptz)',
          range(from, to),
        )
      ).map((r) => r.user_id);
    const totalsAgents = async (from: Date, to: Date) => {
      const [row] = await userRows<{ j: Json }>(
        db,
        u.admin,
        'select public.admin_report_totals($1::timestamptz, $2::timestamptz) as j',
        range(from, to),
      );
      return Number(row.j.agents);
    };

    const quietFrom = new Date(Date.UTC(2020, 0, 1));
    const quietTo = new Date(Date.UTC(2020, 0, 2));
    const quiet = await reportIds(quietFrom, quietTo);
    expect(quiet).not.toContain(deleted);
    expect(quiet).toContain(u.agent);
    expect(await totalsAgents(quietFrom, quietTo)).toBe(quiet.length);

    const lead = await createLeadRow(db, { assigned_to: u.owner });
    const at = new Date(Date.UTC(2021, 5, 1, 15));
    await createCallRow(db, { lead_id: lead.id, user_id: deleted, outcome: 'CONNECTED', duration_seconds: 60, created_at: at });
    expect(await reportIds(new Date(Date.UTC(2021, 5, 1)), new Date(Date.UTC(2021, 5, 2)))).toContain(deleted);
  });

  it('gets zero rows with a token that is still valid', async () => {
    const [row] = await userRows<{ leads: number; profiles: number; calls: number }>(
      db,
      deleted,
      `select (select count(*)::int from public.leads) as leads,
              (select count(*)::int from public.profiles) as profiles,
              (select count(*)::int from public.calls) as calls`,
    );
    expect(row).toEqual({ leads: 0, profiles: 0, calls: 0 });
  });
});

describe('agents and deleted_at', () => {
  it('an agent can neither set nor clear deleted_at on their own profile', async () => {
    const self = await createAuthUser(db, { name: 'Sneaky Agent' });
    expect((await pgError(userRows(db, self, 'update public.profiles set deleted_at = now() where id = $1', [self]))).code).toBe(
      '42501',
    );
    expect(await profile(self)).toMatchObject({ active: true, deleted_at: null });
  });
});

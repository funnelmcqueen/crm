// Bulk lead actions (migration 20260915001600_bulk_leads.sql, docs/DEVIATIONS.md D41). Each function is SECURITY
// INVOKER, so these tests pin that RLS and the guards scope a bulk call exactly like the single-lead paths:
// agents reach only their own leads and columns, admin-only actions refuse agents, and undo only reverts leads
// that still hold the value the bulk action set.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  anonRows,
  bootDb,
  createAuthUser,
  createCallRow,
  createFollowUpRow,
  createLeadRow,
  pgError,
  userRows,
  type PGlite,
} from '../helpers/pglite';

type Row = Record<string, unknown>;

let db: PGlite;
const u = { admin: '', agent: '', other: '', disabled: '' };

async function leadStatus(id: string): Promise<string | undefined> {
  const [row] = await adminSqlRows<{ status: string }>(db, 'select status from public.leads where id = $1', [id]);
  return row?.status;
}

async function leadOwner(id: string): Promise<string | null | undefined> {
  const [row] = await adminSqlRows<{ assigned_to: string | null }>(db, 'select assigned_to from public.leads where id = $1', [id]);
  return row?.assigned_to;
}

function byLead<T extends { lead_id: string }>(rows: T[]): Record<string, T> {
  return Object.fromEntries(rows.map((row) => [row.lead_id, row]));
}

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN', name: 'Bulk Admin' });
  u.agent = await createAuthUser(db, { name: 'Bulk Agent' });
  u.other = await createAuthUser(db, { name: 'Other Agent' });
  u.disabled = await createAuthUser(db, { name: 'Disabled Agent', active: false });
});

afterAll(async () => {
  await db?.close();
});

describe('search_lead_ids', () => {
  it('returns the same leads as search_leads for the same filters, for admins and agents', async () => {
    const source = `bulk-src-${randomUUID().slice(0, 8)}`;
    const mine = await Promise.all([
      createLeadRow(db, { assigned_to: u.agent, source, business_name: 'Zebra Bulk Bakery' }),
      createLeadRow(db, { assigned_to: u.agent, source, status: 'TO_CALL' }),
      createLeadRow(db, { assigned_to: u.agent, status: 'NO_ANSWER' }),
    ]);
    await createLeadRow(db, { assigned_to: u.other, source });
    await createLeadRow(db, { assigned_to: null, source });

    const pageAll = async (caller: string, args: string) => {
      const ids: string[] = [];
      for (let offset = 0; ; offset += 100) {
        const rows = await userRows<{ id: string }>(db, caller, `select id from public.search_leads(${args}, p_limit => 100, p_offset => ${offset})`);
        ids.push(...rows.map((r) => r.id));
        if (rows.length < 100) return ids.sort();
      }
    };
    const idsOf = async (caller: string, args: string) =>
      (await userRows<{ id: string; total_count: number }>(db, caller, `select id, total_count from public.search_lead_ids(${args})`))
        .map((r) => r.id)
        .sort();

    const cases: Array<[string, string]> = [
      [u.admin, `p_source => '${source}'`],
      [u.admin, `p_source => '${source}', p_unassigned => true`],
      [u.admin, `p_source => '${source}', p_assigned_to => '${u.agent}'`],
      [u.admin, `p_query => 'zebra bulk'`],
      [u.agent, `p_source => '${source}'`],
      [u.agent, `p_statuses => array['TO_CALL','NO_ANSWER']::public.lead_status[]`],
      [u.agent, `p_query => null`],
    ];
    for (const [caller, args] of cases) {
      expect(await idsOf(caller, args), args).toEqual(await pageAll(caller, args));
    }
    // An agent's filters never reach another agent's or unassigned leads, even when asked for.
    const agentView = await idsOf(u.agent, `p_source => '${source}', p_unassigned => true`);
    expect(agentView).toEqual([mine[0].id, mine[1].id].sort());
  });

  it('reports the full match count and caps the ids at 5000', async () => {
    const rows = await userRows<{ total_count: number }>(db, u.admin, 'select total_count from public.search_lead_ids(p_limit => 1)');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total_count)).toBeGreaterThan(1);
    const capped = await userRows<Row>(db, u.admin, 'select id from public.search_lead_ids(p_limit => 999999)');
    expect(capped.length).toBeLessThanOrEqual(5000);
  });
});

describe('bulk_set_lead_status', () => {
  const call = (caller: string, ids: string[], status: string, expected: string | null = null) =>
    userRows<{ lead_id: string; previous_status: string; result: string }>(
      db,
      caller,
      'select * from public.bulk_set_lead_status($1::uuid[], $2::public.lead_status, $3::public.lead_status)',
      [ids, status, expected],
    );

  it("changes an agent's own leads, reports previous statuses, and never reaches another agent's lead", async () => {
    const a = await createLeadRow(db, { assigned_to: u.agent, status: 'NEW' });
    const b = await createLeadRow(db, { assigned_to: u.agent, status: 'CONNECTED' });
    const same = await createLeadRow(db, { assigned_to: u.agent, status: 'INTERESTED' });
    const theirs = await createLeadRow(db, { assigned_to: u.other, status: 'NEW' });

    const rows = byLead(await call(u.agent, [a.id, b.id, same.id, theirs.id, randomUUID()], 'INTERESTED'));
    expect(rows[a.id]).toMatchObject({ previous_status: 'NEW', result: 'updated' });
    expect(rows[b.id]).toMatchObject({ previous_status: 'CONNECTED', result: 'updated' });
    expect(rows[same.id]).toMatchObject({ previous_status: 'INTERESTED', result: 'unchanged' });
    expect(rows[theirs.id]).toBeUndefined();
    expect(Object.keys(rows)).toHaveLength(3);

    expect(await leadStatus(a.id)).toBe('INTERESTED');
    expect(await leadStatus(theirs.id)).toBe('NEW');
  });

  it('leaves Do Not Contact leads alone for an agent (locked) but lets an admin reopen them', async () => {
    const dnc = await createLeadRow(db, { assigned_to: u.agent, status: 'DO_NOT_CONTACT' });
    const open = await createLeadRow(db, { assigned_to: u.agent, status: 'NEW' });

    const rows = byLead(await call(u.agent, [dnc.id, open.id], 'TO_CALL'));
    expect(rows[dnc.id]).toMatchObject({ result: 'locked' });
    expect(rows[open.id]).toMatchObject({ result: 'updated' });
    expect(await leadStatus(dnc.id)).toBe('DO_NOT_CONTACT');

    // An agent may still mark leads Do Not Contact.
    expect(byLead(await call(u.agent, [open.id], 'DO_NOT_CONTACT'))[open.id]).toMatchObject({ result: 'updated' });

    expect(byLead(await call(u.admin, [dnc.id], 'TO_CALL'))[dnc.id]).toMatchObject({ result: 'updated' });
    expect(await leadStatus(dnc.id)).toBe('TO_CALL');
  });

  it('with an expected status only changes leads still at it (undo never overwrites a later change)', async () => {
    const kept = await createLeadRow(db, { assigned_to: u.agent, status: 'APPOINTMENT' });
    const changedSince = await createLeadRow(db, { assigned_to: u.agent, status: 'CLIENT' });

    const rows = byLead(await call(u.agent, [kept.id, changedSince.id], 'NEW', 'APPOINTMENT'));
    expect(rows[kept.id]).toMatchObject({ result: 'updated', previous_status: 'APPOINTMENT' });
    expect(rows[changedSince.id]).toMatchObject({ result: 'unchanged' });
    expect(await leadStatus(changedSince.id)).toBe('CLIENT');
  });

  it('refuses anon, a disabled user gets no rows, and more than 5000 ids is invalid', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.disabled, status: 'NEW' });
    expect((await pgError(anonRows(db, "select * from public.bulk_set_lead_status(array[gen_random_uuid()], 'NEW')"))).code).toBe('42501');
    expect(await call(u.disabled, [lead.id], 'CLIENT')).toEqual([]);
    expect(await leadStatus(lead.id)).toBe('NEW');
    const tooMany = Array.from({ length: 5001 }, () => randomUUID());
    expect((await pgError(call(u.admin, tooMany, 'NEW'))).code).toBe('22023');
  });
});

describe('bulk_assign_leads', () => {
  const call = (caller: string, ids: string[], to: string | null, expected: string | null = null, match = false) =>
    userRows<{ lead_id: string; previous_assigned_to: string | null; result: string }>(
      db,
      caller,
      'select * from public.bulk_assign_leads($1::uuid[], $2::uuid, $3::uuid, $4::boolean)',
      [ids, to, expected, match],
    );

  it('is admin only', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agent });
    expect((await pgError(call(u.agent, [lead.id], u.agent))).code).toBe('42501');
    expect(await leadOwner(lead.id)).toBe(u.agent);
  });

  it('assigns and unassigns, reporting previous owners, and open follow-ups move with the lead', async () => {
    const unassigned = await createLeadRow(db, { assigned_to: null });
    const fromOther = await createLeadRow(db, { assigned_to: u.other });
    const already = await createLeadRow(db, { assigned_to: u.agent });
    const open = await createFollowUpRow(db, { lead_id: fromOther.id, user_id: u.other });
    const done = await createFollowUpRow(db, { lead_id: fromOther.id, user_id: u.other, completed_at: new Date() });

    const rows = byLead(await call(u.admin, [unassigned.id, fromOther.id, already.id, randomUUID()], u.agent));
    expect(rows[unassigned.id]).toMatchObject({ previous_assigned_to: null, result: 'updated' });
    expect(rows[fromOther.id]).toMatchObject({ previous_assigned_to: u.other, result: 'updated' });
    expect(rows[already.id]).toMatchObject({ previous_assigned_to: u.agent, result: 'unchanged' });
    expect(Object.keys(rows)).toHaveLength(3);
    expect(await leadOwner(unassigned.id)).toBe(u.agent);

    const followUps = await adminSqlRows<{ id: string; user_id: string }>(db, 'select id, user_id from public.follow_ups where id = any($1::uuid[])', [
      [open.id, done.id],
    ]);
    expect(followUps.find((f) => f.id === open.id)?.user_id).toBe(u.agent);
    expect(followUps.find((f) => f.id === done.id)?.user_id).toBe(u.other);

    const back = byLead(await call(u.admin, [unassigned.id], null));
    expect(back[unassigned.id]).toMatchObject({ previous_assigned_to: u.agent, result: 'updated' });
    expect(await leadOwner(unassigned.id)).toBeNull();
  });

  it('refuses an inactive target and changes nothing', async () => {
    const lead = await createLeadRow(db, { assigned_to: null });
    expect((await pgError(call(u.admin, [lead.id], u.disabled))).code).toBe('22023');
    expect(await leadOwner(lead.id)).toBeNull();
  });

  it('with an expected owner only moves leads still owned by them (undo)', async () => {
    const stillMoved = await createLeadRow(db, { assigned_to: u.agent });
    const movedAgain = await createLeadRow(db, { assigned_to: u.other });
    const rows = byLead(await call(u.admin, [stillMoved.id, movedAgain.id], null, u.agent, true));
    expect(rows[stillMoved.id]).toMatchObject({ result: 'updated' });
    expect(rows[movedAgain.id]).toMatchObject({ result: 'unchanged' });
    expect(await leadOwner(stillMoved.id)).toBeNull();
    expect(await leadOwner(movedAgain.id)).toBe(u.other);
  });
});

describe('bulk_schedule_follow_ups', () => {
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const call = (caller: string, ids: string[], dueAt: string, note: string | null = null, setNote = false) =>
    userRows<{ lead_id: string; follow_up_id: string; result: string }>(
      db,
      caller,
      'select * from public.bulk_schedule_follow_ups($1::uuid[], $2::timestamptz, $3, $4::boolean)',
      [ids, dueAt, note, setNote],
    );

  it("reschedules an agent's earliest open follow-up or creates one, and skips leads they do not own", async () => {
    const withOpen = await createLeadRow(db, { assigned_to: u.agent });
    const earliest = await createFollowUpRow(db, { lead_id: withOpen.id, user_id: u.agent, due_at: new Date(Date.now() + 3_600_000), note: 'keep me' });
    await createFollowUpRow(db, { lead_id: withOpen.id, user_id: u.agent, due_at: new Date(Date.now() + 7 * 86_400_000) });
    const without = await createLeadRow(db, { assigned_to: u.agent });
    const theirs = await createLeadRow(db, { assigned_to: u.other });

    const due = inDays(2);
    const rows = byLead(await call(u.agent, [withOpen.id, without.id, theirs.id], due));
    expect(rows[withOpen.id]).toMatchObject({ result: 'rescheduled', follow_up_id: earliest.id });
    expect(rows[without.id]).toMatchObject({ result: 'created' });
    expect(rows[theirs.id]).toBeUndefined();

    const [kept] = await adminSqlRows<{ due_at: Date; note: string | null }>(db, 'select due_at, note from public.follow_ups where id = $1', [earliest.id]);
    expect(kept.due_at.toISOString()).toBe(due);
    expect(kept.note).toBe('keep me');
    const [created] = await adminSqlRows<{ user_id: string }>(db, 'select user_id from public.follow_ups where id = $1', [rows[without.id].follow_up_id]);
    expect(created.user_id).toBe(u.agent);
    const [synced] = await adminSqlRows<{ next_follow_up_at: Date }>(db, 'select next_follow_up_at from public.leads where id = $1', [without.id]);
    expect(synced.next_follow_up_at.toISOString()).toBe(due);
    expect(await adminSqlRows(db, 'select 1 from public.follow_ups where lead_id = $1', [theirs.id])).toEqual([]);
  });

  it("an admin schedules for the lead's agent, or for themselves on unassigned leads, and can replace the note", async () => {
    const assigned = await createLeadRow(db, { assigned_to: u.other });
    const unassigned = await createLeadRow(db, { assigned_to: null });
    const rows = byLead(await call(u.admin, [assigned.id, unassigned.id], inDays(1), '  Call about pricing  ', true));
    const owners = await adminSqlRows<{ id: string; user_id: string; note: string }>(db, 'select id, user_id, note from public.follow_ups where id = any($1::uuid[])', [
      [rows[assigned.id].follow_up_id, rows[unassigned.id].follow_up_id],
    ]);
    expect(owners.find((f) => f.id === rows[assigned.id].follow_up_id)).toMatchObject({ user_id: u.other, note: 'Call about pricing' });
    expect(owners.find((f) => f.id === rows[unassigned.id].follow_up_id)).toMatchObject({ user_id: u.admin });
  });

  it('refuses times in the past or more than five years out, and notes over 500 characters', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agent });
    expect((await pgError(call(u.agent, [lead.id], inDays(-2)))).code).toBe('22023');
    expect((await pgError(call(u.agent, [lead.id], inDays(365 * 6)))).code).toBe('22023');
    expect((await pgError(call(u.agent, [lead.id], inDays(1), 'x'.repeat(501), true))).code).toBe('22023');
  });
});

describe('bulk_complete_follow_ups', () => {
  it("completes the caller's visible open follow-ups only", async () => {
    const mine = await createLeadRow(db, { assigned_to: u.agent });
    const theirs = await createLeadRow(db, { assigned_to: u.other });
    const a = await createFollowUpRow(db, { lead_id: mine.id, user_id: u.agent });
    const b = await createFollowUpRow(db, { lead_id: mine.id, user_id: u.agent });
    const c = await createFollowUpRow(db, { lead_id: theirs.id, user_id: u.other });

    const [agentCall] = await userRows<{ n: number }>(db, u.agent, 'select public.bulk_complete_follow_ups($1::uuid[]) as n', [[mine.id, theirs.id]]);
    expect(agentCall.n).toBe(2);
    const open = await adminSqlRows<{ id: string }>(db, 'select id from public.follow_ups where id = any($1::uuid[]) and completed_at is null', [[a.id, b.id, c.id]]);
    expect(open.map((r) => r.id)).toEqual([c.id]);
    const [lead] = await adminSqlRows<{ next_follow_up_at: Date | null }>(db, 'select next_follow_up_at from public.leads where id = $1', [mine.id]);
    expect(lead.next_follow_up_at).toBeNull();

    const [adminCall] = await userRows<{ n: number }>(db, u.admin, 'select public.bulk_complete_follow_ups($1::uuid[]) as n', [[theirs.id]]);
    expect(adminCall.n).toBe(1);
  });
});

describe('bulk_set_lead_source and bulk_delete_leads (admin only)', () => {
  it('an agent gets 42501 and nothing changes', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agent, source: 'Original' });
    expect((await pgError(userRows(db, u.agent, "select public.bulk_set_lead_source($1::uuid[], 'Changed')", [[lead.id]]))).code).toBe('42501');
    expect((await pgError(userRows(db, u.agent, 'select public.bulk_delete_leads($1::uuid[])', [[lead.id]]))).code).toBe('42501');
    const [row] = await adminSqlRows<{ source: string }>(db, 'select source from public.leads where id = $1', [lead.id]);
    expect(row.source).toBe('Original');
  });

  it('an admin sets or clears the source and hard-deletes leads with their calls and follow-ups', async () => {
    const a = await createLeadRow(db, { assigned_to: u.agent, source: 'Old' });
    const b = await createLeadRow(db, { assigned_to: null, source: 'New list' });
    const [set] = await userRows<{ n: number }>(db, u.admin, "select public.bulk_set_lead_source($1::uuid[], '  New list ') as n", [[a.id, b.id]]);
    expect(set.n).toBe(1);
    const [cleared] = await userRows<{ n: number }>(db, u.admin, "select public.bulk_set_lead_source($1::uuid[], '   ') as n", [[a.id]]);
    expect(cleared.n).toBe(1);
    const [row] = await adminSqlRows<{ source: string | null }>(db, 'select source from public.leads where id = $1', [a.id]);
    expect(row.source).toBeNull();

    await createCallRow(db, { lead_id: a.id, user_id: u.agent, outcome: 'CONNECTED' });
    await createFollowUpRow(db, { lead_id: a.id, user_id: u.agent });
    const [deleted] = await userRows<{ n: number }>(db, u.admin, 'select public.bulk_delete_leads($1::uuid[]) as n', [[a.id, b.id, randomUUID()]]);
    expect(deleted.n).toBe(2);
    const [left] = await adminSqlRows<{ leads: number; calls: number; follow_ups: number }>(
      db,
      `select (select count(*)::int from public.leads where id = any($1::uuid[])) as leads,
              (select count(*)::int from public.calls where lead_id = $2) as calls,
              (select count(*)::int from public.follow_ups where lead_id = $2) as follow_ups`,
      [[a.id, b.id], a.id],
    );
    expect(left).toEqual({ leads: 0, calls: 0, follow_ups: 0 });
  });
});

describe('export_selected_leads', () => {
  it('returns only selected leads the caller may see, in keyset pages', async () => {
    const mine = await Promise.all([1, 2, 3].map(() => createLeadRow(db, { assigned_to: u.agent })));
    const theirs = await createLeadRow(db, { assigned_to: u.other });
    const ids = [...mine.map((l) => l.id), theirs.id];

    const agentRows = await userRows<{ id: string }>(db, u.agent, 'select id from public.export_selected_leads($1::uuid[])', [ids]);
    expect(agentRows.map((r) => r.id).sort()).toEqual(mine.map((l) => l.id).sort());

    const first = await userRows<{ id: string; created_at: Date }>(db, u.admin, 'select id, created_at from public.export_selected_leads($1::uuid[], p_limit => 2)', [ids]);
    expect(first).toHaveLength(2);
    const last = first[first.length - 1];
    const rest = await userRows<{ id: string }>(
      db,
      u.admin,
      'select id from public.export_selected_leads($1::uuid[], $2::timestamptz, $3::uuid, 2)',
      [ids, last.created_at.toISOString(), last.id],
    );
    expect([...first, ...rest].map((r) => r.id).sort()).toEqual([...ids].sort());
  });
});

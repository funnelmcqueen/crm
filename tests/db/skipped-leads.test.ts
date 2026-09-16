// Skipped queue (migration 20260915001700_skipped_leads.sql, docs/DEVIATIONS.md D42): a skip is saved with its
// reason, keeps the lead out of get_next_lead until it closes, is visible only to its owner (and admins), and
// closes on its own when the lead is called, changes status, gets a follow-up for the skipper, or moves to
// someone else.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  anonRows,
  asUser,
  bootDb,
  createAuthUser,
  createFollowUpRow,
  createLeadRow,
  pgError,
  userRows,
  type PGlite,
} from '../helpers/pglite';

let db: PGlite;
const u = { admin: '', agent: '', other: '' };

interface SkipRow {
  id: string;
  lead_id: string;
  user_id: string;
  reason: string | null;
  note: string | null;
  resolved_at: Date | null;
  resolution: string | null;
}

async function skip(caller: string, leadId: string, reason: string | null = null, note: string | null = null): Promise<string> {
  const [row] = await userRows<{ id: string }>(db, caller, 'select public.skip_lead($1::uuid, $2, $3) as id', [leadId, reason, note]);
  return row.id;
}

async function skipsOf(leadId: string): Promise<SkipRow[]> {
  return adminSqlRows<SkipRow>(db, 'select * from public.lead_skips where lead_id = $1 order by created_at, id', [leadId]);
}

async function nextLeadId(caller: string): Promise<string | undefined> {
  return asUser(db, caller, async (tx) => {
    const { rows } = await tx.query<{ lead_id: string }>("select lead_id from public.get_next_lead('{}')");
    return rows[0]?.lead_id;
  });
}

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN', name: 'Skip Admin' });
  u.agent = await createAuthUser(db, { name: 'Skip Agent' });
  u.other = await createAuthUser(db, { name: 'Other Skipper' });
});

afterAll(async () => {
  await db?.close();
});

describe('skip_lead', () => {
  it('saves the reason and note, and skipping again closes the earlier skip', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agent });
    const first = await skip(u.agent, lead.id, 'call_later', '  After lunch  ');
    const second = await skip(u.agent, lead.id, null, '   ');

    const rows = await skipsOf(lead.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === first)).toMatchObject({ reason: 'CALL_LATER', note: 'After lunch', resolution: 'SKIPPED_AGAIN' });
    expect(rows.find((r) => r.id === second)).toMatchObject({ user_id: u.agent, reason: null, note: null, resolved_at: null });
  });

  it("answers not_found for a lead the caller does not own, admins included, and validates the input", async () => {
    const theirs = await createLeadRow(db, { assigned_to: u.other });
    const unassigned = await createLeadRow(db, { assigned_to: null });
    expect((await pgError(skip(u.agent, theirs.id))).code).toBe('P0002');
    expect((await pgError(skip(u.admin, unassigned.id))).code).toBe('P0002');
    expect((await pgError(skip(u.agent, randomUUID()))).code).toBe('P0002');

    const mine = await createLeadRow(db, { assigned_to: u.agent });
    expect((await pgError(skip(u.agent, mine.id, 'BORED'))).code).toBe('22023');
    expect((await pgError(skip(u.agent, mine.id, null, 'x'.repeat(501)))).code).toBe('22023');
    expect(await skipsOf(theirs.id)).toEqual([]);
    expect(await skipsOf(mine.id)).toEqual([]);
    expect((await pgError(anonRows(db, 'select public.skip_lead($1::uuid)', [mine.id]))).code).toBe('42501');
  });
});

describe('the call queue', () => {
  it('leaves a skipped lead out of get_next_lead, even with an overdue follow-up, until it is resumed', async () => {
    const agent = await createAuthUser(db, { name: 'Queue Agent' });
    const overdue = await createLeadRow(db, { assigned_to: agent, status: 'FOLLOW_UP' });
    await createFollowUpRow(db, { lead_id: overdue.id, user_id: agent, due_at: new Date(Date.now() - 3_600_000) });
    const fresh = await createLeadRow(db, { assigned_to: agent, status: 'NEW' });

    expect(await nextLeadId(agent)).toBe(overdue.id);
    // Skipping resolves nothing about the follow-up; the skip alone keeps it out.
    await skip(agent, overdue.id, 'NOT_PRIORITY');
    expect(await nextLeadId(agent)).toBe(fresh.id);

    const [resumed] = await userRows<{ n: number }>(db, agent, 'select public.resume_skipped_lead($1::uuid) as n', [overdue.id]);
    expect(resumed.n).toBe(1);
    expect(await nextLeadId(agent)).toBe(overdue.id);
    expect((await skipsOf(overdue.id))[0]).toMatchObject({ resolution: 'RESUMED' });
  });
});

describe('who sees and changes skips', () => {
  it('an agent sees only their own skips on their own leads; an admin sees all; nobody writes the table directly', async () => {
    const mine = await createLeadRow(db, { assigned_to: u.agent });
    const theirs = await createLeadRow(db, { assigned_to: u.other });
    await skip(u.agent, mine.id);
    await skip(u.other, theirs.id);

    const agentView = await userRows<{ lead_id: string }>(db, u.agent, 'select lead_id from public.lead_skips where lead_id = any($1::uuid[])', [
      [mine.id, theirs.id],
    ]);
    expect(agentView.map((r) => r.lead_id)).toEqual([mine.id]);
    const adminView = await userRows<{ lead_id: string }>(db, u.admin, 'select lead_id from public.lead_skips where lead_id = any($1::uuid[])', [
      [mine.id, theirs.id],
    ]);
    expect(adminView).toHaveLength(2);

    for (const statement of [
      `insert into public.lead_skips (lead_id, user_id) values ('${mine.id}', '${u.agent}')`,
      `update public.lead_skips set resolved_at = now(), resolution = 'RESUMED' where lead_id = '${mine.id}'`,
      `delete from public.lead_skips where lead_id = '${mine.id}'`,
    ]) {
      expect((await pgError(userRows(db, u.agent, statement))).code, statement).toBe('42501');
      expect((await pgError(userRows(db, u.admin, statement))).code, statement).toBe('42501');
    }
  });

  it("resume_skipped_lead: an agent resumes only their own lead's skip, an admin resumes any", async () => {
    const theirs = await createLeadRow(db, { assigned_to: u.other });
    await skip(u.other, theirs.id);
    const [byAgent] = await userRows<{ n: number }>(db, u.agent, 'select public.resume_skipped_lead($1::uuid) as n', [theirs.id]);
    expect(byAgent.n).toBe(0);
    expect((await skipsOf(theirs.id))[0].resolved_at).toBeNull();
    const [byAdmin] = await userRows<{ n: number }>(db, u.admin, 'select public.resume_skipped_lead($1::uuid) as n', [theirs.id]);
    expect(byAdmin.n).toBe(1);
  });
});

describe('skips close when the work moves on', () => {
  it('calling the lead closes the skip (log_call)', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agent, status: 'NEW' });
    await skip(u.agent, lead.id);
    await userRows(db, u.agent, "select public.log_call(p_outcome => 'NO_ANSWER', p_lead_id => $1::uuid)", [lead.id]);
    expect((await skipsOf(lead.id))[0]).toMatchObject({ resolution: 'CALLED' });
  });

  it('a status change closes the skip', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agent, status: 'NEW' });
    await skip(u.agent, lead.id, 'BAD_DATA');
    await userRows(db, u.agent, "update public.leads set status = 'NOT_INTERESTED' where id = $1", [lead.id]);
    expect((await skipsOf(lead.id))[0]).toMatchObject({ resolution: 'STATUS_CHANGED' });
  });

  it("a follow-up scheduled for the skipper closes it; a completed one or someone else's does not", async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agent });
    await skip(u.agent, lead.id);
    await createFollowUpRow(db, { lead_id: lead.id, user_id: u.admin, completed_at: new Date() });
    await createFollowUpRow(db, { lead_id: lead.id, user_id: u.other });
    expect((await skipsOf(lead.id))[0].resolved_at).toBeNull();

    const own = await createFollowUpRow(db, { lead_id: lead.id, user_id: u.agent });
    expect((await skipsOf(lead.id))[0]).toMatchObject({ resolution: 'FOLLOW_UP' });

    // Rescheduling counts as scheduling; completing does not.
    await skip(u.agent, lead.id);
    await adminSqlRows(db, 'update public.follow_ups set completed_at = now() where id = $1', [own.id]);
    const open = (await skipsOf(lead.id)).filter((r) => r.resolved_at === null);
    expect(open).toHaveLength(1);
  });

  it('reassigning closes the skips of everyone who no longer owns the lead', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agent });
    await skip(u.agent, lead.id);
    await userRows(db, u.admin, 'select public.reassign_leads(array[$1]::uuid[], $2::uuid)', [lead.id, u.other]);
    expect((await skipsOf(lead.id))[0]).toMatchObject({ resolution: 'REASSIGNED' });
  });
});

describe('list_skipped_leads', () => {
  it('lists open skips longest-waiting first: own for an agent, everyone with the owner name for an admin', async () => {
    const agent = await createAuthUser(db, { name: 'List Agent' });
    const older = await createLeadRow(db, { assigned_to: agent, business_name: 'Older Skip Co' });
    const newer = await createLeadRow(db, { assigned_to: agent, business_name: 'Newer Skip Co' });
    const closed = await createLeadRow(db, { assigned_to: agent, business_name: 'Closed Skip Co' });
    await skip(agent, older.id, 'NEEDS_RESEARCH', 'Check the website');
    await adminSqlRows(db, "update public.lead_skips set created_at = now() - interval '2 hours' where lead_id = $1", [older.id]);
    await skip(agent, newer.id);
    await skip(agent, closed.id);
    await userRows(db, agent, 'select public.resume_skipped_lead($1::uuid)', [closed.id]);

    type Listed = { lead_id: string; reason: string | null; note: string | null; owner_name: string | null; assigned_to: string | null; total_count: number };
    const agentRows = await userRows<Listed>(db, agent, 'select * from public.list_skipped_leads(10, 0)');
    expect(agentRows.map((r) => r.lead_id)).toEqual([older.id, newer.id]);
    expect(agentRows[0]).toMatchObject({ reason: 'NEEDS_RESEARCH', note: 'Check the website', owner_name: null, assigned_to: null });
    expect(Number(agentRows[0].total_count)).toBe(2);

    const adminRows = await userRows<Listed>(db, u.admin, 'select * from public.list_skipped_leads(100, 0)');
    expect(adminRows.find((r) => r.lead_id === older.id)).toMatchObject({ owner_name: 'List Agent', assigned_to: agent });
    expect(adminRows.some((r) => r.lead_id === closed.id)).toBe(false);

    const paged = await userRows<Listed>(db, agent, 'select * from public.list_skipped_leads(1, 1)');
    expect(paged.map((r) => r.lead_id)).toEqual([newer.id]);
  });
});

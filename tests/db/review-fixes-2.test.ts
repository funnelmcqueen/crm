// Stages 6-10 review fixes, round 2 (supabase/migrations/20260915001200_review_fixes_2.sql).
//
//   * The admin dashboard and Reports both label a number "Clients". They counted different things:
//     the dashboard counted every CLIENT lead in the pipeline, Reports summed per-agent rows that only
//     list leads currently assigned to someone (and only listed admins that had made calls).
//   * The dashboard's team talk tile rounded while its per-agent rows floor, so the tile could never be
//     reconciled with the rows under it. The totals now carry raw seconds too.
//   * The Voicemails tab badge counted unheard voicemails while the tab lists every voicemail.
//   * A number assigned to an agent who is then disabled stays assigned and leaves the pool, with
//     nothing on the Phone Numbers page saying so.
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
  userRows,
  type PGlite,
} from '../helpers/pglite';

let db: PGlite;
let admin = '';

beforeAll(async () => {
  db = await bootDb();
  admin = await createAuthUser(db, { role: 'ADMIN', name: 'Fixes Admin', timezone: 'America/New_York' });
});

afterAll(async () => {
  await db?.close();
});

const DAY = 86_400_000;

async function teamTotals(): Promise<Record<string, number>> {
  const [row] = await userRows<{ t: Record<string, number> }>(db, admin, 'select public.admin_team_totals() as t');
  return row.t;
}

async function reportTotals(): Promise<Record<string, number>> {
  const [row] = await userRows<{ t: Record<string, number> }>(
    db,
    admin,
    'select public.admin_report_totals($1, $2) as t',
    [new Date(Date.now() - DAY), new Date(Date.now() + DAY)],
  );
  return row.t;
}

async function reportAgents(): Promise<Array<Record<string, unknown>>> {
  return userRows<Record<string, unknown>>(db, admin, 'select * from public.admin_report_agents($1, $2)', [
    new Date(Date.now() - DAY),
    new Date(Date.now() + DAY),
  ]);
}

describe('"Clients" means the same thing on the dashboard and in Reports', () => {
  let agent = '';
  let quietAdmin = '';

  beforeAll(async () => {
    agent = await createAuthUser(db, { name: 'Clients Agent', timezone: 'America/New_York' });
    // An admin who holds a client lead but made no calls: previously in no report row at all.
    quietAdmin = await createAuthUser(db, { role: 'ADMIN', name: 'Quiet Admin' });
    await createLeadRow(db, { assigned_to: agent, status: 'CLIENT' });
    await createLeadRow(db, { assigned_to: quietAdmin, status: 'CLIENT' });
    await createLeadRow(db, { assigned_to: null, status: 'CLIENT' });
  });

  it('splits the dashboard count into assigned and unassigned', async () => {
    const totals = await teamTotals();
    expect(Number(totals.clients_assigned) + Number(totals.clients_unassigned)).toBe(Number(totals.clients_total));
    expect(Number(totals.clients_unassigned)).toBeGreaterThanOrEqual(1);
  });

  it('gives the reports total the same number as the dashboard assigned count', async () => {
    const [team, report] = await Promise.all([teamTotals(), reportTotals()]);
    expect(Number(report.clients)).toBe(Number(team.clients_assigned));
  });

  it('keeps the reports total equal to the sum of its own rows', async () => {
    const [rows, report] = await Promise.all([reportAgents(), reportTotals()]);
    const sum = rows.reduce((acc, row) => acc + Number(row.clients), 0);
    expect(Number(report.clients)).toBe(sum);
    expect(Number(report.agents)).toBe(rows.length);
  });

  it('lists an admin that holds client leads without having made calls', async () => {
    const rows = await reportAgents();
    const row = rows.find((entry) => entry.user_id === quietAdmin);
    expect(row, 'admin holding a client lead must have a row').toBeDefined();
    expect(Number(row?.clients)).toBe(1);
    expect(Number(row?.dials)).toBe(0);
  });
});

describe('team talk time carries seconds, not only rounded minutes', () => {
  it('reports the exact sum of the per-agent talk seconds', async () => {
    const agent = await createAuthUser(db, { name: 'Talk Fixes Agent', timezone: 'America/New_York' });
    const lead = await createLeadRow(db, { assigned_to: agent });
    await createCallRow(db, { lead_id: lead.id, user_id: agent, outcome: 'CONNECTED', duration_seconds: 30 });

    const rows = await userRows<Record<string, unknown>>(db, admin, 'select * from public.admin_agent_rows()');
    const sum = rows.reduce((acc, row) => acc + Number(row.talk_seconds_today), 0);

    const totals = await teamTotals();
    expect(Number(totals.talk_seconds_today)).toBe(sum);
    // The rounded field stays, for surfaces that show whole minutes.
    expect(Number(totals.talk_minutes_today)).toBe(Math.round(sum / 60));
  });
});

describe('the Voicemails badge counts what the Voicemails tab lists', () => {
  let agent = '';

  beforeAll(async () => {
    agent = await createAuthUser(db, { name: 'Voicemail Agent', timezone: 'America/New_York' });
    const lead = await createLeadRow(db, { assigned_to: agent });
    for (const minutes of [10, 20]) {
      await createCallRow(db, {
        lead_id: lead.id,
        user_id: agent,
        direction: 'INBOUND',
        mode: 'IN_APP',
        provider_call_sid: fakeTwilioSid('CA'),
        voicemail_recording_sid: fakeTwilioSid('RE'),
        voicemail_duration_seconds: 12,
        created_at: new Date(Date.now() - minutes * 60_000),
      });
    }
    await createFollowUpRow(db, { lead_id: lead.id, user_id: agent });
  });

  async function counts(): Promise<Record<string, number>> {
    const [row] = await userRows<{ c: Record<string, number> }>(db, agent, 'select public.follow_up_tab_counts() as c');
    return row.c;
  }

  async function listedVoicemails(): Promise<number> {
    const rows = await userRows<{ total_count: number | bigint }>(
      db,
      agent,
      'select * from public.list_voicemails(false, 100, 0)',
    );
    return rows.length;
  }

  it('equals the number of rows the tab shows', async () => {
    const [c, listed] = await Promise.all([counts(), listedVoicemails()]);
    expect(Number(c.voicemails_total)).toBe(listed);
    expect(listed).toBe(2);
  });

  it('keeps counting voicemails after they have been heard', async () => {
    const before = await counts();
    expect(Number(before.voicemails_unheard)).toBe(2);

    const voicemailIds = await adminSqlRows<{ id: string }>(
      db,
      'select id from public.calls where user_id = $1 and voicemail_recording_sid is not null',
      [agent],
    );
    for (const { id } of voicemailIds) {
      await userRows(db, agent, 'select public.mark_voicemail_heard($1)', [id]);
    }

    const after = await counts();
    expect(Number(after.voicemails_unheard)).toBe(0);
    // The tab still lists both, so the badge must still say 2.
    expect(Number(after.voicemails_total)).toBe(await listedVoicemails());
    expect(Number(after.voicemails_total)).toBe(2);
  });

  it('is zero for a disabled caller, like every other count', async () => {
    const gone = await createAuthUser(db, { name: 'Gone Voicemail' });
    await adminSqlRows(db, 'update public.profiles set active = false where id = $1', [gone]);
    const [row] = await userRows<{ c: Record<string, number> }>(db, gone, 'select public.follow_up_tab_counts() as c');
    expect(Number(row.c.voicemails_total)).toBe(0);
    expect(Number(row.c.voicemails_unheard)).toBe(0);
  });
});

describe('a number assigned to a disabled agent is visible as parked', () => {
  it('reports whether the assignee is still an active user', async () => {
    const owner = await createAuthUser(db, { name: 'Leaving Owner' });
    const number = await createPhoneNumberRow(db, { assigned_to: owner });
    const active = await createAuthUser(db, { name: 'Staying Owner' });
    const held = await createPhoneNumberRow(db, { assigned_to: active });
    const pool = await createPhoneNumberRow(db, {});

    await adminSqlRows(db, 'update public.profiles set active = false where id = $1', [owner]);

    const rows = await userRows<Record<string, unknown>>(db, admin, 'select * from public.admin_phone_number_rows()');
    const parked = rows.find((row) => row.id === number.id);
    expect(parked).toMatchObject({ assigned_to: owner, assigned_name: 'Leaving Owner', assigned_active: false });
    expect(rows.find((row) => row.id === held.id)).toMatchObject({ assigned_active: true });
    // An unassigned number has no assignee to describe.
    expect(rows.find((row) => row.id === pool.id)).toMatchObject({ assigned_to: null, assigned_name: null, assigned_active: null });
  });
});

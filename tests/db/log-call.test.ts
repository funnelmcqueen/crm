// log_call semantics: ownership, idempotency, counting, status mapping parity with the domain lib,
// notes rules, follow-ups and voicemail side effects.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_OUTCOMES, applyWrongNumberPrefix, normalizeCallNotes, outcomeToStatus } from '../../src/lib/domain/outcomes';
import { LEAD_STATUSES } from '../../src/lib/domain/statuses';
import {
  adminSqlRows,
  asUser,
  bootDb,
  createAuthUser,
  createCallRow,
  createFollowUpRow,
  createLeadRow,
  fakeTwilioSid,
  pgError,
  userRows,
  type PGlite,
} from '../helpers/pglite';

let db: PGlite;
const u = { admin: '', a: '', b: '', inactive: '' };

interface LogCallArgs {
  outcome: string | null;
  leadId?: string | null;
  callId?: string | null;
  notes?: string | null;
  followUpAt?: Date | null;
  followUpNote?: string | null;
  duration?: number | null;
}

interface LogCallResult {
  call_id: string;
  lead_id: string | null;
  status: string | null;
  call_count: number | null;
  next_follow_up_at: string | null;
}

function logCall(userId: string, args: LogCallArgs): Promise<LogCallResult> {
  return asUser(db, userId, async (tx) => {
    const { rows } = await tx.query<{ r: LogCallResult }>(
      `select public.log_call(
         p_outcome => $1::public.call_outcome, p_lead_id => $2::uuid, p_call_id => $3::uuid, p_notes => $4::text,
         p_follow_up_at => $5::timestamptz, p_follow_up_note => $6::text, p_duration_seconds => $7::int) as r`,
      [
        args.outcome,
        args.leadId ?? null,
        args.callId ?? null,
        args.notes ?? null,
        args.followUpAt ?? null,
        args.followUpNote ?? null,
        args.duration ?? null,
      ],
    );
    return rows[0].r;
  });
}

async function leadState(id: string): Promise<{ status: string; call_count: number; last_contacted_at: Date | null; next_follow_up_at: Date | null }> {
  const [row] = await adminSqlRows<{ status: string; call_count: number; last_contacted_at: Date | null; next_follow_up_at: Date | null }>(
    db,
    'select status, call_count, last_contacted_at, next_follow_up_at from public.leads where id = $1',
    [id],
  );
  return row;
}

async function callRow(id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await adminSqlRows<Record<string, unknown>>(db, 'select * from public.calls where id = $1', [id]);
  return row;
}

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN' });
  u.a = await createAuthUser(db);
  u.b = await createAuthUser(db);
  u.inactive = await createAuthUser(db, { active: false });
});

afterAll(async () => {
  await db?.close();
});

describe('TEL logging and counting', () => {
  it('inserts a TEL call row keyed by the client id (never used as the row id) and counts it once', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a, status: 'NEW' });
    const callId = crypto.randomUUID();
    const result = await logCall(u.a, { outcome: 'NO_ANSWER', leadId: lead.id, callId, duration: 0 });
    expect(result).toMatchObject({ lead_id: lead.id, status: 'NO_ANSWER', call_count: 1 });
    expect(result.call_id).not.toBe(callId);
    expect(await callRow(callId)).toBeUndefined();
    expect(await callRow(result.call_id)).toMatchObject({
      client_request_id: callId,
      duration_seconds: 0,
      lead_id: lead.id,
      user_id: u.a,
      direction: 'OUTBOUND',
      mode: 'TEL',
      remote_e164: lead.phone,
      outcome: 'NO_ANSWER',
      provider_call_sid: null,
    });
    const state = await leadState(lead.id);
    expect(state.call_count).toBe(1);
    expect(state.last_contacted_at).not.toBeNull();
  });

  // PGlite has one connection, so the "concurrent" retries below run serially; real lock contention
  // is only exercised against an external Postgres.
  it('re-logging the same call id never double counts, duplicates the follow-up or changes the duration', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const callId = crypto.randomUUID();
    const first = await logCall(u.a, { outcome: 'FOLLOW_UP', leadId: lead.id, callId, followUpAt: new Date(Date.now() - 60_000), duration: 12 });
    const relog = await logCall(u.a, { outcome: 'CONNECTED', leadId: lead.id, callId, notes: 'second try', duration: 99 });
    expect(relog).toMatchObject({ call_id: first.call_id, call_count: 1, status: 'CONNECTED' });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        logCall(u.a, { outcome: 'FOLLOW_UP', leadId: lead.id, callId, notes: `retry ${i}`, followUpAt: new Date(Date.now() - 60_000), duration: 500 }),
      ),
    );
    expect((await leadState(lead.id)).call_count).toBe(1);
    expect(await adminSqlRows(db, 'select count(*)::int as n from public.calls where lead_id = $1', [lead.id])).toEqual([{ n: 1 }]);
    expect(await callRow(first.call_id)).toMatchObject({ outcome: 'FOLLOW_UP', duration_seconds: 12 });
    expect(await adminSqlRows(db, 'select completed_at from public.follow_ups where lead_id = $1', [lead.id])).toEqual([{ completed_at: null }]);
  });

  it('concurrent first logs with the same new call id create one row and one count', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const callId = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => logCall(u.a, { outcome: 'VOICEMAIL', leadId: lead.id, callId })));
    expect(new Set(results.map((r) => r.call_id)).size).toBe(1);
    expect(results[0].call_id).not.toBe(callId);
    expect((await leadState(lead.id)).call_count).toBe(1);
  });

  it('separate calls without a client id count separately', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    await logCall(u.a, { outcome: 'NO_ANSWER', leadId: lead.id });
    const second = await logCall(u.a, { outcome: 'NO_ANSWER', leadId: lead.id });
    expect(second.call_count).toBe(2);
  });

  it('a pre-created in-app row is counted on its first outcome only; its duration is never taken from the client', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const [{ id }] = await userRows<{ id: string }>(db, u.a, 'select public.create_outbound_call($1) as id', [lead.id]);
    expect((await logCall(u.a, { outcome: 'CONNECTED', callId: id, duration: 42 })).call_count).toBe(1);
    expect((await logCall(u.a, { outcome: 'APPOINTMENT', callId: id, leadId: lead.id, duration: 99 })).call_count).toBe(1);
    expect(await callRow(id)).toMatchObject({ outcome: 'APPOINTMENT', duration_seconds: null, mode: 'IN_APP' });
  });

  it('an unmatched inbound call of the caller can be logged without a lead, but not with a follow-up', async () => {
    const call = await createCallRow(db, {
      lead_id: null,
      user_id: u.a,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
    });
    expect(await logCall(u.a, { outcome: 'CONNECTED', callId: call.id })).toEqual({
      call_id: call.id,
      lead_id: null,
      status: null,
      call_count: null,
      next_follow_up_at: null,
    });
    const err = await pgError(logCall(u.a, { outcome: 'FOLLOW_UP', callId: call.id, followUpAt: new Date(Date.now() + 86_400_000) }));
    expect(err.code).toBe('22023');
  });
});

describe('status mapping parity with src/lib/domain/outcomes.ts', () => {
  it('outcome_to_status matches outcomeToStatus for all 8 outcomes x 12 statuses', async () => {
    const rows = await userRows<{ outcome: string; current: string; result: string }>(
      db,
      u.a,
      `select o::text as outcome, s::text as current, public.outcome_to_status(o, s)::text as result
         from unnest(enum_range(null::public.call_outcome)) o
         cross join unnest(enum_range(null::public.lead_status)) s`,
    );
    expect(rows).toHaveLength(96);
    for (const row of rows) {
      expect(`${row.outcome}/${row.current} -> ${row.result}`).toBe(
        `${row.outcome}/${row.current} -> ${outcomeToStatus(row.outcome as (typeof CALL_OUTCOMES)[number], row.current as (typeof LEAD_STATUSES)[number])}`,
      );
    }
  });

  it('log_call applies the same mapping (including no-downgrade and sticky DO_NOT_CONTACT) on real leads', async () => {
    const mismatches: string[] = [];
    for (const outcome of CALL_OUTCOMES) {
      for (const status of LEAD_STATUSES) {
        const lead = await createLeadRow(db, { assigned_to: u.a, status });
        const call = await createCallRow(db, { lead_id: lead.id, user_id: u.a, mode: 'IN_APP' });
        const result = await logCall(u.a, {
          outcome,
          callId: call.id,
          followUpAt: outcome === 'FOLLOW_UP' ? new Date(Date.now() + 86_400_000) : null,
        });
        const expected = outcomeToStatus(outcome, status);
        if (result.status !== expected || (await leadState(lead.id)).status !== expected) {
          mismatches.push(`${outcome} on ${status}: got ${result.status}, expected ${expected}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);

  it('never downgrades APPOINTMENT/PROPOSAL/CLIENT on No Answer or Voicemail', async () => {
    for (const status of ['APPOINTMENT', 'PROPOSAL', 'CLIENT']) {
      const lead = await createLeadRow(db, { assigned_to: u.a, status });
      expect((await logCall(u.a, { outcome: 'NO_ANSWER', leadId: lead.id })).status).toBe(status);
      expect((await logCall(u.a, { outcome: 'VOICEMAIL', leadId: lead.id })).status).toBe(status);
    }
  });
});

describe('notes', () => {
  const NOTES: Array<string | null> = [
    null,
    '',
    '   ',
    ' \n\t\r\f\v ',
    'Asked for Bob',
    '  padded note \n',
    'Wrong number',
    'wrong NUMBER',
    'Wrong number — already prefixed',
    'WRONG NUMBER — shouting',
    'Wrong numbers again',
    'Wrong number - hyphen',
    'Wrong number—no spaces',
    ' nbsp edges ',
    'multi\nline\nnote',
    'Ünïcödé 📞 notes',
  ];

  it.each(NOTES.map((n) => [n]))('WRONG_NUMBER stores applyWrongNumberPrefix(%j) and a retry keeps it', async (notes) => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const callId = crypto.randomUUID();
    const first = await logCall(u.a, { outcome: 'WRONG_NUMBER', leadId: lead.id, callId, notes });
    const stored = (await callRow(first.call_id))?.notes;
    expect(stored).toBe(applyWrongNumberPrefix(notes));
    expect((await leadState(lead.id)).status).toBe('DO_NOT_CONTACT');

    // The client retries the save with the notes it now displays: no double prefix, no double count.
    await logCall(u.a, { outcome: 'WRONG_NUMBER', leadId: lead.id, callId, notes: stored as string });
    expect((await callRow(first.call_id))?.notes).toBe(applyWrongNumberPrefix(notes));
    expect((await leadState(lead.id)).call_count).toBe(1);
  });

  it.each(NOTES.map((n) => [n]))('other outcomes store normalizeCallNotes(%j)', async (notes) => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const result = await logCall(u.a, { outcome: 'CONNECTED', leadId: lead.id, notes });
    expect((await callRow(result.call_id))?.notes ?? null).toBe(normalizeCallNotes(notes));
  });
});

describe('follow-ups and voicemails', () => {
  it('FOLLOW_UP requires a follow-up date', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    expect((await pgError(logCall(u.a, { outcome: 'FOLLOW_UP', leadId: lead.id }))).code).toBe('22023');
    expect((await leadState(lead.id)).call_count).toBe(0);
  });

  it('creates the follow-up for the lead owner and updates next_follow_up_at', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const due = new Date(Date.now() + 2 * 86_400_000);
    const result = await logCall(u.a, { outcome: 'FOLLOW_UP', leadId: lead.id, followUpAt: due, followUpNote: '  ' });
    expect(new Date(result.next_follow_up_at as string).getTime()).toBe(due.getTime());
    const fus = await adminSqlRows<{ user_id: string; note: string | null; completed_at: Date | null }>(
      db,
      'select user_id, note, completed_at from public.follow_ups where lead_id = $1',
      [lead.id],
    );
    expect(fus).toEqual([{ user_id: u.a, note: null, completed_at: null }]);
  });

  it('an admin logging on an agent lead creates the follow-up for that agent; on an unassigned lead for the admin', async () => {
    const owned = await createLeadRow(db, { assigned_to: u.a });
    const unassigned = await createLeadRow(db);
    const due = new Date(Date.now() + 86_400_000);
    await logCall(u.admin, { outcome: 'FOLLOW_UP', leadId: owned.id, followUpAt: due, followUpNote: 'check' });
    await logCall(u.admin, { outcome: 'FOLLOW_UP', leadId: unassigned.id, followUpAt: due });
    expect(await adminSqlRows(db, 'select user_id, note from public.follow_ups where lead_id = $1', [owned.id])).toEqual([
      { user_id: u.a, note: 'check' },
    ]);
    expect(await adminSqlRows(db, 'select user_id from public.follow_ups where lead_id = $1', [unassigned.id])).toEqual([{ user_id: u.admin }]);
    expect(await adminSqlRows(db, 'select user_id from public.calls where lead_id = $1', [owned.id])).toEqual([{ user_id: u.admin }]);
  });

  it('completes follow-ups that are already due and keeps future ones open', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const overdue = await createFollowUpRow(db, { lead_id: lead.id, user_id: u.a, due_at: new Date(Date.now() - 86_400_000) });
    const future = await createFollowUpRow(db, { lead_id: lead.id, user_id: u.a, due_at: new Date(Date.now() + 5 * 86_400_000) });
    const result = await logCall(u.a, { outcome: 'CONNECTED', leadId: lead.id });
    const rows = await adminSqlRows<{ id: string; completed_at: Date | null }>(
      db,
      'select id, completed_at from public.follow_ups where lead_id = $1',
      [lead.id],
    );
    expect(rows.find((r) => r.id === overdue.id)?.completed_at).not.toBeNull();
    expect(rows.find((r) => r.id === future.id)?.completed_at).toBeNull();
    expect(new Date(result.next_follow_up_at as string).getTime()).toBe(future.due_at.getTime());
  });

  it("marks the lead's unheard voicemails as handled", async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const voicemail = await createCallRow(db, {
      lead_id: lead.id,
      user_id: u.a,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      voicemail_recording_sid: fakeTwilioSid('RE'),
    });
    await logCall(u.a, { outcome: 'CONNECTED', leadId: lead.id });
    expect((await callRow(voicemail.id))?.handled_at).not.toBeNull();
  });
});

describe('access', () => {
  it("returns not_found for another agent's lead or call, and never modifies them", async () => {
    const leadA = await createLeadRow(db, { assigned_to: u.a });
    const leadB = await createLeadRow(db, { assigned_to: u.b, status: 'INTERESTED' });
    const callB = await createCallRow(db, { lead_id: leadB.id, user_id: u.b, mode: 'IN_APP' });

    const attempts: LogCallArgs[] = [
      { outcome: 'NOT_INTERESTED', leadId: leadB.id },
      { outcome: 'NOT_INTERESTED', leadId: leadB.id, callId: crypto.randomUUID() },
      { outcome: 'NOT_INTERESTED', callId: callB.id },
      { outcome: 'NOT_INTERESTED', callId: callB.id, leadId: leadB.id },
      { outcome: 'NOT_INTERESTED', leadId: crypto.randomUUID() },
      { outcome: 'NOT_INTERESTED', callId: crypto.randomUUID() },
    ];
    for (const attempt of attempts) {
      const err = await pgError(logCall(u.a, attempt));
      expect({ attempt, code: err.code, message: err.message }).toEqual({ attempt, code: 'P0002', message: 'not_found' });
    }
    expect(await leadState(leadB.id)).toMatchObject({ status: 'INTERESTED', call_count: 0 });
    expect(await callRow(callB.id)).toMatchObject({ outcome: null });
    expect((await leadState(leadA.id)).call_count).toBe(0);

    // B's call id with A's own lead is just an unknown client key: a new TEL call on A's lead, exactly as
    // for a random id, and B's call is untouched.
    const onOwn = await logCall(u.a, { outcome: 'NOT_INTERESTED', callId: callB.id, leadId: leadA.id });
    expect(onOwn).toMatchObject({ lead_id: leadA.id, call_count: 1 });
    expect(onOwn.call_id).not.toBe(callB.id);
    expect(await callRow(callB.id)).toMatchObject({ outcome: null, lead_id: leadB.id });
  });

  it("returns not_found when the call id is the caller's own but the lead id differs", async () => {
    const lead1 = await createLeadRow(db, { assigned_to: u.a });
    const lead2 = await createLeadRow(db, { assigned_to: u.a });
    const call = await createCallRow(db, { lead_id: lead1.id, user_id: u.a, mode: 'IN_APP' });
    expect((await pgError(logCall(u.a, { outcome: 'CONNECTED', callId: call.id, leadId: lead2.id }))).code).toBe('P0002');
  });

  it("a pre-created call on a lead that was reassigned away is not_found for the old agent", async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const call = await createCallRow(db, { lead_id: lead.id, user_id: u.a, mode: 'IN_APP' });
    await userRows(db, u.admin, 'select public.reassign_leads(array[$1::uuid], $2::uuid)', [lead.id, u.b]);
    expect((await pgError(logCall(u.a, { outcome: 'CONNECTED', callId: call.id }))).code).toBe('P0002');
  });

  it('validates input and the caller', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    expect((await pgError(logCall(u.a, { outcome: null, leadId: lead.id }))).code).toBe('22023');
    expect((await pgError(logCall(u.a, { outcome: 'CONNECTED' }))).code).toBe('22023');
    expect((await pgError(logCall(u.a, { outcome: 'CONNECTED', leadId: lead.id, duration: -1 }))).code).toBe('22023');
    const inactiveLead = await createLeadRow(db, { assigned_to: u.inactive });
    expect((await pgError(logCall(u.inactive, { outcome: 'CONNECTED', leadId: inactiveLead.id }))).code).toBe('42501');
  });

  it('refuses a new TEL call on a DO_NOT_CONTACT lead but allows logging an existing row (D8, D11)', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a, status: 'DO_NOT_CONTACT' });
    const err = await pgError(logCall(u.a, { outcome: 'CONNECTED', leadId: lead.id, callId: crypto.randomUUID() }));
    expect(err).toEqual({ code: 'P0001', message: 'do_not_contact' });
    const inbound = await createCallRow(db, {
      lead_id: lead.id,
      user_id: u.a,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
    });
    expect(await logCall(u.a, { outcome: 'INTERESTED', callId: inbound.id })).toMatchObject({ status: 'DO_NOT_CONTACT', call_count: 1 });
  });

  it('an admin can log on any lead', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.b });
    expect(await logCall(u.admin, { outcome: 'CONNECTED', leadId: lead.id })).toMatchObject({ status: 'CONNECTED', call_count: 1 });
  });
});

// Regression tests for the stage-1 adversarial review: each describe block reproduces one finding
// (rate-limit resets, existence oracles, recording SID exposure, concurrent calls, default
// privileges, stranded follow-ups, DO_NOT_CONTACT re-opening, log_call retries and duration, search
// digit matching, caller ID locking, timezone boundaries and sub-less JWT claims).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  asUser,
  bootDb,
  createAuthUser,
  createCallRow,
  createFollowUpRow,
  createLeadRow,
  fakeTwilioSid,
  insertRow,
  pgError,
  serviceRows,
  userRows,
  type PGlite,
  type Transaction,
} from '../helpers/pglite';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let db: PGlite;
const u = { admin: '', a: '', b: '' };

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN' });
  u.a = await createAuthUser(db);
  u.b = await createAuthUser(db);
});

afterAll(async () => {
  await db?.close();
});

interface LogCallArgs {
  outcome: string;
  leadId?: string | null;
  callId?: string | null;
  notes?: string | null;
  followUpAt?: Date | null;
  duration?: number | null;
}

interface LogCallResult {
  call_id: string;
  lead_id: string | null;
  status: string | null;
  call_count: number | null;
}

function logCall(userId: string, args: LogCallArgs): Promise<LogCallResult> {
  return asUser(db, userId, async (tx) => {
    const { rows } = await tx.query<{ r: LogCallResult }>(
      `select public.log_call(p_outcome => $1::public.call_outcome, p_lead_id => $2::uuid, p_call_id => $3::uuid,
         p_notes => $4::text, p_follow_up_at => $5::timestamptz, p_duration_seconds => $6::int) as r`,
      [args.outcome, args.leadId ?? null, args.callId ?? null, args.notes ?? null, args.followUpAt ?? null, args.duration ?? null],
    );
    return rows[0].r;
  });
}

const createOutbound = async (userId: string, leadId: string): Promise<string> =>
  (await userRows<{ id: string }>(db, userId, 'select public.create_outbound_call($1::uuid) as id', [leadId]))[0].id;

/** 'ok' when the promise resolves, otherwise the SQLSTATE and message, so two probes can be compared. */
async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return `${e.code ?? '?'} ${e.message ?? ''}`;
  }
}

const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  (await adminSqlRows<{ n: number }>(db, sql, params))[0].n;

describe('rate limits cannot be reset or skipped by the caller', () => {
  it('hits inside the fixed voice_token window survive any direct consume_rate_limit call', async () => {
    const agent = await createAuthUser(db);
    for (let i = 0; i < 20; i += 1) {
      await insertRow(db, 'rate_limit_hits', { user_id: agent, bucket: 'voice_token', created_at: new Date(Date.now() - 2_000) });
    }
    // Attempts to shrink the window (the old 3-argument signature) or reset the bucket.
    for (const sql of [
      `select public.consume_rate_limit('voice_token', 10000, 1)`,
      `select public.consume_rate_limit('voice_token', 1, 1)`,
      `select public.consume_rate_limit('voice_token')`,
    ]) {
      await outcomeOf(userRows(db, agent, sql));
    }
    expect(
      await count(`select count(*)::int as n from public.rate_limit_hits where user_id = $1 and created_at < now() - interval '1 second'`, [agent]),
    ).toBe(20);
    expect(await userRows(db, agent, `select public.consume_rate_limit('voice_token') as ok`)).toEqual([{ ok: false }]);
  });

  it('create_outbound_call enforces the outbound_call limit itself (12 per minute), so a direct RPC call is limited too', async () => {
    const agent = await createAuthUser(db);
    const lead = await createLeadRow(db, { assigned_to: agent });
    for (let i = 0; i < 12; i += 1) await createOutbound(agent, lead.id);
    expect(await pgError(createOutbound(agent, lead.id))).toEqual({ code: 'P0001', message: 'rate_limited' });
    const other = await createAuthUser(db);
    const otherLead = await createLeadRow(db, { assigned_to: other });
    expect(await createOutbound(other, otherLead.id)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('one dialable in-app call per agent', () => {
  it("a new in-app call supersedes the caller's un-started pre-created calls", async () => {
    const agent = await createAuthUser(db);
    const lead = await createLeadRow(db, { assigned_to: agent });
    const first = await createOutbound(agent, lead.id);
    const second = await createOutbound(agent, lead.id);
    expect(second).not.toBe(first);
    const pending = await adminSqlRows<{ id: string }>(
      db,
      `select id from public.calls
        where user_id = $1 and mode = 'IN_APP' and provider_call_sid is null and call_status is null and outcome is null`,
      [agent],
    );
    expect(pending).toEqual([{ id: second }]);
  });

  it('never removes a call that started or was logged', async () => {
    const agent = await createAuthUser(db);
    const lead = await createLeadRow(db, { assigned_to: agent });
    const logged = await createOutbound(agent, lead.id);
    await logCall(agent, { outcome: 'NO_ANSWER', callId: logged });
    const started = await createOutbound(agent, lead.id);
    await db.query(`update public.calls set provider_call_sid = $2, call_status = 'completed' where id = $1`, [started, fakeTwilioSid('CA')]);
    await createOutbound(agent, lead.id);
    expect(await count('select count(*)::int as n from public.calls where id = any($1::uuid[])', [[logged, started]])).toBe(2);
  });

  it('a logged call no longer blocks the next call while its final status callback is pending', async () => {
    const agent = await createAuthUser(db);
    const lead = await createLeadRow(db, { assigned_to: agent });
    const id = await createOutbound(agent, lead.id);
    await db.query(`update public.calls set provider_call_sid = $2, call_status = 'in-progress' where id = $1`, [id, fakeTwilioSid('CA')]);
    expect(await pgError(createOutbound(agent, lead.id))).toEqual({ code: 'P0001', message: 'call_in_progress' });
    await logCall(agent, { outcome: 'CONNECTED', callId: id });
    expect(await createOutbound(agent, lead.id)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('client-chosen ids are never an existence oracle', () => {
  it('a follow-up insert with an explicit id is refused identically for existing and missing ids', async () => {
    const own = await createLeadRow(db, { assigned_to: u.a });
    const foreignLead = await createLeadRow(db, { assigned_to: u.b });
    const foreign = await createFollowUpRow(db, { lead_id: foreignLead.id, user_id: u.b });
    const insert = (id: string) =>
      userRows(db, u.a, 'insert into public.follow_ups (id, lead_id, user_id, due_at) values ($1, $2, $3, now()) returning id', [id, own.id, u.a]);
    const existing = await outcomeOf(insert(foreign.id));
    const missing = await outcomeOf(insert(crypto.randomUUID()));
    expect(existing).toBe(missing);
    expect(existing).toMatch(/^42501 /);
    // Choosing created_at is refused too; choosing nothing works.
    expect((await pgError(userRows(db, u.a, `insert into public.follow_ups (lead_id, user_id, due_at, created_at) values ($1, $2, now(), now())`, [own.id, u.a]))).code).toBe('42501');
    expect(await userRows(db, u.a, 'insert into public.follow_ups (lead_id, user_id, due_at) values ($1, $2, now()) returning user_id', [own.id, u.a])).toEqual([
      { user_id: u.a },
    ]);
  });

  it('log_call with a known call id the caller no longer owns behaves exactly like a brand-new id, before and after deletion', async () => {
    const agentA = await createAuthUser(db);
    const agentB = await createAuthUser(db);
    const moved = await createLeadRow(db, { assigned_to: agentA });
    const telKey = crypto.randomUUID();
    const tel = await logCall(agentA, { outcome: 'FOLLOW_UP', leadId: moved.id, callId: telKey, followUpAt: new Date(Date.now() + 2 * DAY) });
    const inApp = await createOutbound(agentA, moved.id);
    await logCall(agentA, { outcome: 'CONNECTED', callId: inApp });
    const bLead = await createLeadRow(db, { assigned_to: agentB });
    const bCall = await createCallRow(db, { lead_id: bLead.id, user_id: agentB, outcome: 'INTERESTED' });
    await userRows(db, u.admin, 'select public.reassign_leads(array[$1::uuid], $2::uuid)', [moved.id, agentB]);

    // Each phase probes a fresh own lead: a probe that succeeds stores its id as that lead's client key.
    const probe = async (ownLeadId: string, callId: string, leadId: string | null) => {
      const before = await count('select call_count as n from public.leads where id = $1', [ownLeadId]);
      const result = await outcomeOf(
        logCall(agentA, { outcome: 'NO_ANSWER', leadId, callId }).then((r) => {
          expect(r.call_id).not.toBe(callId);
          expect(r.lead_id).toBe(leadId);
        }),
      );
      const after = await count('select call_count as n from public.leads where id = $1', [ownLeadId]);
      return `${result} +${after - before}`;
    };

    const known = [tel.call_id, telKey, inApp, bCall.id];
    for (const phase of ['lead exists', 'lead deleted']) {
      const own = await createLeadRow(db, { assigned_to: agentA });
      const reference = await probe(own.id, crypto.randomUUID(), own.id);
      const referenceNoLead = await probe(own.id, crypto.randomUUID(), null);
      expect(reference, phase).toBe('ok +1');
      expect(referenceNoLead, phase).toBe('P0002 not_found +0');
      for (const id of known) {
        expect(await probe(own.id, id, own.id), `${phase}: ${id}`).toBe(reference);
        expect(await probe(own.id, id, null), `${phase}: ${id}`).toBe(referenceNoLead);
      }
      if (phase === 'lead exists') await db.query('delete from public.leads where id = any($1::uuid[])', [[moved.id, bLead.id]]);
    }
  });

  it('a TEL save retried with the same client id and lead is still counted once', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const key = crypto.randomUUID();
    const first = await logCall(u.a, { outcome: 'NO_ANSWER', leadId: lead.id, callId: key });
    const retry = await logCall(u.a, { outcome: 'CONNECTED', leadId: lead.id, callId: key });
    const byRowId = await logCall(u.a, { outcome: 'INTERESTED', callId: first.call_id });
    expect(new Set([first.call_id, retry.call_id, byRowId.call_id]).size).toBe(1);
    expect(byRowId.call_count).toBe(1);
    expect(await count('select count(*)::int as n from public.calls where lead_id = $1', [lead.id])).toBe(1);
  });
});

describe('voicemail recording SIDs never reach an API role', () => {
  let agent = '';
  let voicemail = '';
  let unmatched = '';
  const sid = fakeTwilioSid('RE');

  beforeAll(async () => {
    agent = await createAuthUser(db);
    const lead = await createLeadRow(db, { assigned_to: agent });
    voicemail = (
      await createCallRow(db, { lead_id: lead.id, user_id: agent, direction: 'INBOUND', mode: 'IN_APP', provider_call_sid: fakeTwilioSid('CA'), voicemail_recording_sid: sid })
    ).id;
    unmatched = (
      await createCallRow(db, { lead_id: null, user_id: null, direction: 'INBOUND', mode: 'IN_APP', provider_call_sid: fakeTwilioSid('CA'), voicemail_recording_sid: fakeTwilioSid('RE') })
    ).id;
  });

  it('the owning agent and the admin cannot fetch the SID through any get_voicemail_recording signature', async () => {
    for (const userId of [agent, u.admin]) {
      for (const [sql, params] of [
        ['select public.get_voicemail_recording($1::uuid) as sid', [voicemail]],
        ['select public.get_voicemail_recording($1::uuid, $2::uuid) as sid', [voicemail, userId]],
      ] as const) {
        const result = await outcomeOf(userRows(db, userId, sql, [...params]));
        expect(result).toMatch(/^(42501|42883) /);
      }
    }
  });

  it('service_role gets the SID only when the given user may access the voicemail', async () => {
    const recording = async (callId: string, userId: string | null) =>
      (await serviceRows<{ sid: string | null }>(db, 'select public.get_voicemail_recording($1::uuid, $2::uuid) as sid', [callId, userId]))[0].sid;
    expect(await recording(voicemail, agent)).toBe(sid);
    expect(await recording(voicemail, u.b)).toBeNull();
    expect(await recording(voicemail, null)).toBeNull();
    expect(await recording(unmatched, agent)).toBeNull();
    expect(await recording(unmatched, u.admin)).not.toBeNull();
    const inactive = await createAuthUser(db, { active: false });
    const inactiveLead = await createLeadRow(db, { assigned_to: inactive });
    const inactiveVm = await createCallRow(db, { lead_id: inactiveLead.id, user_id: inactive, direction: 'INBOUND', mode: 'IN_APP', voicemail_recording_sid: fakeTwilioSid('RE') });
    expect(await recording(inactiveVm.id, inactive)).toBeNull();
  });
});

describe('default privileges for tables added by later migrations', () => {
  it('authenticated gets no TRUNCATE, REFERENCES or TRIGGER on a new public table', async () => {
    await db.exec('create table public.zz_default_table_probe (id int primary key); alter table public.zz_default_table_probe enable row level security');
    try {
      const [row] = await adminSqlRows<Record<string, boolean>>(
        db,
        `select has_table_privilege('authenticated', 'public.zz_default_table_probe', 'TRUNCATE') as truncate,
                has_table_privilege('authenticated', 'public.zz_default_table_probe', 'REFERENCES') as references,
                has_table_privilege('authenticated', 'public.zz_default_table_probe', 'TRIGGER') as trigger,
                has_table_privilege('anon', 'public.zz_default_table_probe', 'SELECT') as anon_select`,
      );
      expect(row).toEqual({ truncate: false, references: false, trigger: false, anon_select: false });
      expect((await pgError(userRows(db, u.a, 'truncate public.zz_default_table_probe'))).code).toBe('42501');
    } finally {
      await db.exec('drop table public.zz_default_table_probe');
    }
  });
});

describe('open follow-ups follow the lead owner on every assignment path', () => {
  it('a direct admin update of assigned_to moves open follow-ups; the new owner can see and complete them', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a, status: 'CONNECTED' });
    const open = await createFollowUpRow(db, { lead_id: lead.id, user_id: u.a, due_at: new Date(Date.now() - HOUR) });
    const done = await createFollowUpRow(db, { lead_id: lead.id, user_id: u.a, due_at: new Date(Date.now() - DAY), completed_at: new Date() });

    expect(await userRows(db, u.admin, 'update public.leads set assigned_to = $2 where id = $1 returning id', [lead.id, u.b])).toHaveLength(1);
    expect(await userRows(db, u.b, 'select id from public.follow_ups where lead_id = $1', [lead.id])).toEqual([{ id: open.id }]);
    const next = await userRows<{ lead_id: string; reason: string }>(db, u.b, 'select lead_id, reason from public.get_next_lead() where lead_id = $1', [lead.id]);
    expect(next).toEqual([{ lead_id: lead.id, reason: 'OVERDUE' }]);
    expect(await userRows(db, u.b, 'update public.follow_ups set completed_at = now() where lead_id = $1 and completed_at is null returning id', [lead.id])).toEqual([
      { id: open.id },
    ]);
    expect(await adminSqlRows(db, 'select user_id from public.follow_ups where id = $1', [done.id])).toEqual([{ user_id: u.a }]);
  });

  it('unassigning and later assigning moves the stranded open follow-ups to the new owner', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const open = await createFollowUpRow(db, { lead_id: lead.id, user_id: u.a });
    await userRows(db, u.admin, 'select public.reassign_leads(array[$1::uuid], null)', [lead.id]);
    await userRows(db, u.admin, 'update public.leads set assigned_to = $2 where id = $1', [lead.id, u.b]);
    expect(await adminSqlRows(db, 'select user_id from public.follow_ups where id = $1', [open.id])).toEqual([{ user_id: u.b }]);
  });
});

describe('DO_NOT_CONTACT can only be re-opened by an admin', () => {
  it('an agent cannot move their own lead out of DO_NOT_CONTACT, and so cannot dial it', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a, status: 'DO_NOT_CONTACT' });
    for (const status of ['NEW', 'TO_CALL', 'INTERESTED']) {
      expect((await pgError(userRows(db, u.a, 'update public.leads set status = $2::public.lead_status where id = $1', [lead.id, status]))).code).toBe('42501');
    }
    expect(await pgError(createOutbound(u.a, lead.id))).toEqual({ code: 'P0001', message: 'do_not_contact' });
    expect(await userRows(db, u.a, `update public.leads set notes = 'still reachable?' where id = $1 returning status`, [lead.id])).toEqual([
      { status: 'DO_NOT_CONTACT' },
    ]);
    expect(await userRows(db, u.admin, `update public.leads set status = 'TO_CALL' where id = $1 returning status`, [lead.id])).toEqual([{ status: 'TO_CALL' }]);
  });

  it('an agent may still mark a lead DO_NOT_CONTACT', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a, status: 'NEW' });
    expect(await userRows(db, u.a, `update public.leads set status = 'DO_NOT_CONTACT' where id = $1 returning status`, [lead.id])).toEqual([
      { status: 'DO_NOT_CONTACT' },
    ]);
  });
});

describe('log_call retries and durations', () => {
  it('retrying a save with a follow-up creates exactly one follow-up and never completes it', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const key = crypto.randomUUID();
    for (let i = 0; i < 3; i += 1) {
      await logCall(u.a, { outcome: 'FOLLOW_UP', leadId: lead.id, callId: key, followUpAt: new Date(Date.now() + 2 * DAY), notes: 'call back' });
    }
    expect(await adminSqlRows(db, 'select completed_at from public.follow_ups where lead_id = $1', [lead.id])).toEqual([{ completed_at: null }]);
    expect(await count('select call_count as n from public.leads where id = $1', [lead.id])).toBe(1);
  });

  it('Twilio is the source of truth for in-app talk time; an agent-supplied duration is ignored', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const id = await createOutbound(u.a, lead.id);
    const callSid = fakeTwilioSid('CA');
    await db.query(`update public.calls set provider_call_sid = $2, call_status = 'in-progress' where id = $1`, [id, callSid]);
    await logCall(u.a, { outcome: 'CONNECTED', callId: id, duration: 36_000 });
    await serviceRows(db, `select public.apply_call_status($1, 'completed', 30)`, [callSid]);
    expect(await adminSqlRows(db, 'select call_status, duration_seconds from public.calls where id = $1', [id])).toEqual([
      { call_status: 'completed', duration_seconds: 30 },
    ]);
  });

  it('rejects a manual duration above 24 hours', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    expect((await pgError(logCall(u.a, { outcome: 'CONNECTED', leadId: lead.id, duration: 86_401 }))).code).toBe('22023');
    expect((await logCall(u.a, { outcome: 'CONNECTED', leadId: lead.id, duration: 86_400 })).call_count).toBe(1);
  });
});

describe('search_leads phone digit matching', () => {
  it('matches phone digits only when the query looks like a phone number', async () => {
    const agent = await createAuthUser(db);
    await createLeadRow(db, { assigned_to: agent, business_name: 'Suite 100 Dental', phone: '+12025550123' });
    await createLeadRow(db, { assigned_to: agent, business_name: 'Other Co', phone: '+13105551009' });
    const names = async (query: string) =>
      (await userRows<{ business_name: string }>(db, agent, 'select business_name from public.search_leads(p_query => $1)', [query]))
        .map((r) => r.business_name)
        .sort();
    expect(await names('Suite 100')).toEqual(['Suite 100 Dental']);
    expect(await names('(310) 555-1009')).toEqual(['Other Co']);
    expect(await names('+1 310.555.1009')).toEqual(['Other Co']);
    expect(await names('100')).toEqual(['Other Co', 'Suite 100 Dental']);
  });
});

describe('claim_caller_id locking', () => {
  it("locks the agent's own number without SKIP LOCKED, so a concurrent FK row lock never falls back to the pool", async () => {
    // PGlite has a single connection, so lock contention cannot be exercised here; the lock clause is checked instead.
    const [{ def }] = await adminSqlRows<{ def: string }>(db, `select pg_get_functiondef('public.claim_caller_id(uuid)'::regprocedure) as def`);
    const sql = def.toLowerCase().replace(/\s+/g, ' ');
    const assigned = sql.slice(sql.indexOf('n.assigned_to = p_user_id'), sql.indexOf('n.assigned_to is null'));
    const pool = sql.slice(sql.indexOf('n.assigned_to is null'));
    expect(assigned).toContain('for no key update');
    expect(assigned).not.toContain('skip locked');
    expect(pool).toContain('for no key update skip locked');
  });
});

describe('get_next_lead DUE_TODAY uses the local day of the agent', () => {
  it.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/New_York'])('in %s', async (zone) => {
    const agent = await createAuthUser(db, { timezone: zone });
    const [bounds] = await adminSqlRows<{ late: Date; early: Date; now: Date }>(
      db,
      `select (date_trunc('day', now() at time zone $1) + interval '23 hours 59 minutes 59 seconds') at time zone $1 as late,
              (date_trunc('day', now() at time zone $1) + interval '1 day 30 minutes') at time zone $1 as early,
              now() as now`,
      [zone],
    );
    if (bounds.late.getTime() <= bounds.now.getTime() + MINUTE) return;
    const late = await createLeadRow(db, { assigned_to: agent, business_name: 'Late today', status: 'CONNECTED' });
    const early = await createLeadRow(db, { assigned_to: agent, business_name: 'Early tomorrow', status: 'CONNECTED' });
    await createFollowUpRow(db, { lead_id: late.id, user_id: agent, due_at: bounds.late });
    await createFollowUpRow(db, { lead_id: early.id, user_id: agent, due_at: bounds.early });
    const rows = await userRows<{ business_name: string; reason: string }>(db, agent, 'select business_name, reason from public.get_next_lead()');
    expect(rows).toEqual([{ business_name: 'Late today', reason: 'DUE_TODAY' }]);
    const skipped = await userRows(db, agent, 'select business_name from public.get_next_lead(array[$1::uuid])', [late.id]);
    expect(skipped).toEqual([]);
  });
});

describe('authenticated JWT claims without sub (auth.uid() is null)', () => {
  let lead = '';

  beforeAll(async () => {
    lead = (await createLeadRow(db, { assigned_to: null, source: 'Unassigned source' })).id;
    await createFollowUpRow(db, { lead_id: (await createLeadRow(db, { assigned_to: u.a })).id, user_id: u.a });
  });

  const asNoSub = <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => {
      await tx.exec('set local role authenticated');
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', aud: 'authenticated' })]);
      return fn(tx);
    });
  const rows = (sql: string, params: unknown[] = []) => asNoSub(async (tx) => (await tx.query(sql, params)).rows);

  it.each([
    'select id from public.profiles',
    'select id from public.leads',
    'select id from public.calls',
    'select id from public.follow_ups',
    'select id from public.phone_numbers',
    'select id from public.settings',
    'select * from public.get_next_lead()',
    'select * from public.search_leads(p_unassigned => true)',
    'select * from public.list_lead_sources()',
    'select * from public.list_voicemails()',
  ])('gets zero rows: %s', async (sql) => {
    expect(await rows(sql)).toEqual([]);
  });

  it('gets nothing from scalar RPCs and is refused by mutating RPCs', async () => {
    expect(await rows('select public.can_access_lead($1) as a, public.is_admin() as b, public.is_active_user() as c, public.unheard_voicemail_count() as n', [lead])).toEqual([
      { a: false, b: false, c: false, n: 0 },
    ]);
    for (const sql of [
      `select public.log_call('CONNECTED', p_lead_id => $1)`,
      'select public.create_outbound_call($1)',
      'select public.reassign_leads(array[$1::uuid], null)',
    ]) {
      expect((await pgError(rows(sql, [lead]))).code).toMatch(/^(42501|P0002)$/);
    }
    for (const sql of ['select public.touch_device_presence()', `select public.consume_rate_limit('voice_token')`]) {
      expect((await pgError(rows(sql))).code).toBe('42501');
    }
    expect(await rows(`update public.leads set notes = 'x' where id = $1 returning id`, [lead])).toEqual([]);
    expect((await pgError(rows('insert into public.follow_ups (lead_id, user_id, due_at) values ($1, $2, now())', [lead, u.a]))).code).toBe('42501');
    expect(await adminSqlRows(db, 'select assigned_to, notes from public.leads where id = $1', [lead])).toEqual([{ assigned_to: null, notes: null }]);
  });
});

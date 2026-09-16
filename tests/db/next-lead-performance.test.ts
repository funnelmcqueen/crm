// get_next_lead is the hot path: it runs on every agent dashboard render and every Save & Next, so it
// sets the felt latency of the product's main interaction.
//
// It used to attach two correlated scalar subqueries — the oldest unhandled voicemail and the earliest
// open follow-up — to *every* one of the caller's assigned leads, before any bucket filtering and before
// the LIMIT 1. The only filter applied first was `assigned_to = v_uid`, so a single suggestion walked the
// agent's entire book twice over. Measured on a 50k-lead database it was ~487ms, about 4x slower than any
// other query in the app, and it grows with leads-per-agent.
//
// The rewrite computes both values set-based (one grouped pass per child table, joined to the candidate
// leads) instead of once per lead. This test pins both halves of that: the shape, so the correlated form
// cannot come back, and the cost, measured against a trivial query over the same rows so a slow machine
// moves both numbers together.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSqlRows, asUser, bootDb, createAuthUser, type PGlite } from '../helpers/pglite';

const LEADS = 3000;
const CALLS_PER_LEAD = 2;
const RUNS = 5;
/** get_next_lead may cost this many times a plain count over the same leads. Correlated: ~33x. */
const MAX_COST_RATIO = 12;

let db: PGlite;
let agent = '';
let other = '';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function timeMedian(fn: () => Promise<unknown>): Promise<number> {
  await fn(); // warm up: first call plans the statement
  const times: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const started = performance.now();
    await fn();
    times.push(performance.now() - started);
  }
  return median(times);
}

const nextLead = () => asUser(db, agent, async (tx) => (await tx.query('select * from public.get_next_lead()')).rows);
const countOwnLeads = () =>
  asUser(db, agent, async (tx) => (await tx.query('select count(*) from public.leads where assigned_to = $1', [agent])).rows);

beforeAll(async () => {
  db = await bootDb();
  agent = await createAuthUser(db);
  other = await createAuthUser(db);

  // A realistic book: most leads belong to the agent, a tenth to someone else, a third contacted
  // recently, a few hundred with open follow-ups, a handful with an unheard voicemail.
  await db.query(
    `insert into public.leads (business_name, phone, city, state, status, assigned_to, last_contacted_at, created_at)
     select 'Bench ' || n,
            '+1212555' || lpad(n::text, 4, '0'),
            'Testville', 'NY',
            (array['NEW','TO_CALL','NO_ANSWER','VOICEMAIL','CONNECTED','INTERESTED'])[1 + (n % 6)]::public.lead_status,
            case when n % 10 = 0 then $2::uuid else $1::uuid end,
            case when n % 3 = 0 then now() - interval '10 days' else null end,
            now() - (n || ' minutes')::interval
       from generate_series(1, $3::int) as n`,
    [agent, other, LEADS],
  );
  await db.query(
    `insert into public.calls (lead_id, user_id, direction, mode, created_at)
     select l.id, $1::uuid, 'OUTBOUND', 'TEL', now() - interval '2 days'
       from public.leads l, generate_series(1, $2::int)`,
    [agent, CALLS_PER_LEAD],
  );
  await db.query(
    `insert into public.calls (lead_id, user_id, direction, mode, created_at, provider_call_sid, voicemail_recording_sid)
     select l.id, $1::uuid, 'INBOUND', 'IN_APP', now() - interval '1 day',
            'CA' || lpad(row_number() over (order by l.id)::text, 32, '0'),
            'RE' || lpad(row_number() over (order by l.id)::text, 32, '0')
       from public.leads l where l.assigned_to = $1::uuid order by l.id limit 5`,
    [agent],
  );
  await db.query(
    `insert into public.follow_ups (lead_id, user_id, due_at)
     select l.id, $1::uuid, now() + interval '2 hours'
       from public.leads l where l.assigned_to = $1::uuid order by l.id offset 10 limit 500`,
    [agent],
  );
  await db.exec('analyze');
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('get_next_lead under volume', () => {
  it('still suggests the oldest unhandled voicemail first', async () => {
    const rows = (await nextLead()) as Array<{ reason: string; business_name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('VOICEMAIL');
  });

  it('does not compute the voicemail and follow-up lookups once per assigned lead', async () => {
    const [{ def }] = await adminSqlRows<{ def: string }>(
      db,
      `select pg_get_functiondef('public.get_next_lead(uuid[])'::regprocedure) as def`,
    );
    const correlated = [/where\s+c\.lead_id\s*=\s*l\.id/i, /where\s+f\.lead_id\s*=\s*l\.id/i];
    for (const pattern of correlated) {
      expect(
        pattern.test(def),
        'get_next_lead attaches a per-lead subquery to every assigned lead before filtering; aggregate the child tables instead',
      ).toBe(false);
    }
    expect(def.toLowerCase()).toContain('group by');
  });

  it(`costs no more than ${MAX_COST_RATIO}x a plain count over the same leads`, async () => {
    const control = await timeMedian(countOwnLeads);
    const suggestion = await timeMedian(nextLead);
    const ratio = suggestion / Math.max(control, 0.5);
    expect(
      ratio,
      `get_next_lead took ${suggestion.toFixed(1)}ms against a ${control.toFixed(1)}ms control over ${LEADS} leads`,
    ).toBeLessThan(MAX_COST_RATIO);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anonRows, bootDb, createAuthUser, createCallRow, createLeadRow, pgError, userRows,
  type PGlite,
} from '../helpers/pglite';

let db: PGlite;
let admin: string;
let agent: string;
let other: string;
let inactive: string;
let ownMissed: string;
let ownAnswered: string;
let ownVoicemail: string;
let otherCall: string;
let adminOnly: string;

const sql = `select * from public.list_call_history($1::text, $2::uuid, $3::int, $4::int)`;
type HistoryRow = { call_id: string; user_id: string | null; agent_name: string | null; lead_id: string | null;
  business_name: string | null; remote_e164: string | null; direction: string; has_voicemail: boolean; total_count: number };
const history = (userId: string, tab = 'all', agentId: string | null = null, limit = 50, offset = 0) =>
  userRows<HistoryRow>(db, userId, sql, [tab, agentId, limit, offset]);

beforeAll(async () => {
  db = await bootDb();
  admin = await createAuthUser(db, { name: 'History Admin', role: 'ADMIN' });
  agent = await createAuthUser(db, { name: 'History Agent' });
  other = await createAuthUser(db, { name: 'Other Agent' });
  inactive = await createAuthUser(db, { name: 'Disabled Agent', active: false });
  const lead = await createLeadRow(db, { assigned_to: other, business_name: 'Moved Lead' });
  ownMissed = (await createCallRow(db, { lead_id: lead.id, user_id: agent, direction: 'INBOUND', mode: 'IN_APP',
    call_status: 'no-answer', remote_e164: '+12125550101' })).id;
  ownAnswered = (await createCallRow(db, { lead_id: lead.id, user_id: agent, direction: 'INBOUND', mode: 'IN_APP',
    call_status: 'completed', outcome: 'CONNECTED', duration_seconds: 40 })).id;
  ownVoicemail = (await createCallRow(db, { lead_id: null, user_id: agent, direction: 'INBOUND', mode: 'IN_APP',
    call_status: 'completed', remote_e164: '+12125550102', voicemail_recording_sid: 'REhistory',
    voicemail_duration_seconds: 12 })).id;
  otherCall = (await createCallRow(db, { lead_id: lead.id, user_id: other, direction: 'OUTBOUND', mode: 'TEL' })).id;
  adminOnly = (await createCallRow(db, { lead_id: null, user_id: null, direction: 'INBOUND', mode: 'IN_APP',
    call_status: 'no-answer', remote_e164: '+12125550103' })).id;
});

afterAll(async () => { await db?.close(); });

describe('list_call_history', () => {
  it('returns only the agent’s own calls even when a lead belongs to someone else or an agent filter is supplied', async () => {
    const rows = await history(agent, 'all', other);
    expect(rows.map((row) => row.call_id).sort()).toEqual([ownMissed, ownAnswered, ownVoicemail].sort());
    expect(rows.every((row) => row.user_id === agent)).toBe(true);
    expect(rows.find((row) => row.call_id === ownMissed)).toMatchObject({ business_name: 'Moved Lead', remote_e164: '+12125550101' });
  });

  it('lets an admin see all calls and filter by agent, including unknown callers', async () => {
    const all = await history(admin);
    expect(all.map((row) => row.call_id).sort()).toEqual([ownMissed, ownAnswered, ownVoicemail, otherCall, adminOnly].sort());
    expect(all.find((row) => row.call_id === ownMissed)?.agent_name).toBe('History Agent');
    expect(all.find((row) => row.call_id === adminOnly)).toMatchObject({ lead_id: null, user_id: null, remote_e164: '+12125550103' });
    expect((await history(admin, 'all', other)).map((row) => row.call_id)).toEqual([otherCall]);
  });

  it('filters missed and voicemail rows without classifying answered calls as missed', async () => {
    expect((await history(agent, 'missed')).map((row) => row.call_id).sort()).toEqual([ownMissed, ownVoicemail].sort());
    const voicemail = await history(agent, 'voicemail');
    expect(voicemail.map((row) => row.call_id)).toEqual([ownVoicemail]);
    expect(voicemail[0].has_voicemail).toBe(true);
  });

  it('paginates with the full count and denies inactive and anon callers', async () => {
    const page = await history(agent, 'all', null, 1, 1);
    expect(page).toHaveLength(1);
    expect(Number(page[0].total_count)).toBe(3);
    expect(await history(inactive)).toEqual([]);
    expect((await pgError(anonRows(db, sql, ['all', null, 50, 0]))).code).toBe('42501');
    const grants = await db.query<{ service: boolean; anon: boolean }>(
      `select has_function_privilege('service_role', 'public.list_call_history(text,uuid,integer,integer)', 'execute') as service,
              has_function_privilege('anon', 'public.list_call_history(text,uuid,integer,integer)', 'execute') as anon`,
    );
    expect(grants.rows[0]).toEqual({ service: true, anon: false });
  });
});

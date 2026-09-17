// Business type on leads (migration 20260915001900_calendar_booking.sql, docs/DEVIATIONS.md D46): agents correct it
// on their own leads through set_lead_business_type; admins set it on any lead and in bulk.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSqlRows, bootDb, createAuthUser, createLeadRow, pgError, userRows, type PGlite } from '../helpers/pglite';

let db: PGlite;
const u = { admin: '', agent: '', other: '' };

const SET = 'select public.set_lead_business_type($1::uuid, $2::public.business_type)';
const BULK = 'select public.bulk_set_business_type($1::uuid[], $2::public.business_type) as n';

async function typeOf(leadId: string): Promise<string | null> {
  const [row] = await adminSqlRows<{ business_type: string | null }>(db, 'select business_type from public.leads where id = $1', [leadId]);
  return row.business_type;
}

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN', name: 'Type Admin' });
  u.agent = await createAuthUser(db, { name: 'Type Agent' });
  u.other = await createAuthUser(db, { name: 'Other Agent' });
});

afterAll(async () => {
  await db?.close();
});

describe('set_lead_business_type', () => {
  it('lets an agent set and clear the type on their own lead', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agent });
    await userRows(db, u.agent, SET, [lead.id, 'restaurant']);
    expect(await typeOf(lead.id)).toBe('restaurant');
    await userRows(db, u.agent, SET, [lead.id, null]);
    expect(await typeOf(lead.id)).toBeNull();
  });

  it("answers not_found for another agent's lead and lets an admin set any lead", async () => {
    const lead = await createLeadRow(db, { assigned_to: u.other });
    expect((await pgError(userRows(db, u.agent, SET, [lead.id, 'auto']))).code).toBe('P0002');
    await userRows(db, u.admin, SET, [lead.id, 'auto']);
    expect(await typeOf(lead.id)).toBe('auto');
  });

  it('rejects a value outside the enum', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agent });
    expect((await pgError(userRows(db, u.agent, SET, [lead.id, 'dentist']))).code).toBe('22P02');
  });
});

describe('bulk_set_business_type', () => {
  it('sets the type on many leads for an admin and counts only real changes', async () => {
    const a = await createLeadRow(db, { assigned_to: u.agent });
    const b = await createLeadRow(db, { assigned_to: u.other });
    const [first] = await userRows<{ n: number }>(db, u.admin, BULK, [[a.id, b.id, a.id], 'hotel_motel']);
    expect(first.n).toBe(2);
    const [again] = await userRows<{ n: number }>(db, u.admin, BULK, [[a.id, b.id], 'hotel_motel']);
    expect(again.n).toBe(0);
    const [cleared] = await userRows<{ n: number }>(db, u.admin, BULK, [[a.id], null]);
    expect(cleared.n).toBe(1);
    expect(await typeOf(a.id)).toBeNull();
  });

  it('is admin only and caps the selection at 5,000', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agent });
    expect((await pgError(userRows(db, u.agent, BULK, [[lead.id], 'retail']))).code).toBe('42501');
    const tooMany = Array.from({ length: 5001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect((await pgError(userRows(db, u.admin, BULK, [tooMany, 'retail']))).message).toBe('too_many_leads');
  });
});

// Bulk lead actions through the service layer with real sessions (docs/DEVIATIONS.md D41): agents act on their
// own leads only and never on admin-only actions, results count what changed and why the rest did not, undo
// only reverts leads still holding the bulk value, and "Select all matching" follows the Leads list filters.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '@/server/context';
import {
  bulkAssign,
  bulkCompleteFollowUps,
  bulkDelete,
  bulkScheduleFollowUp,
  bulkSetSource,
  bulkUpdateStatus,
  listMatchingLeadIds,
  undoBulkAssign,
  undoBulkStatus,
} from '@/server/services/bulk-leads';
import { handleSelectedLeadsExport } from '@/server/http/leads-export';
import { serviceClient, signInAs } from '../../helpers/clients';
import { contextFor, contextForUser } from '../../helpers/context';
import { createFollowUp, createLead, createUser, disableUser, type FixtureUser, type Lead } from '../../helpers/fixtures';
import { signInSeeded } from '../../helpers/seeded';
import { APP_BASE_URL, stubSessionEnv, unstubSessionEnv } from '../../routes/_helpers';

const TAG = `BULK${randomUUID().slice(0, 8)}`;
const DAY = 86_400_000;

let agentA: FixtureUser;
let agentB: FixtureUser;
let ctxA: RequestContext;
let ctxAdmin: RequestContext;

async function leadRows(ids: string[]) {
  const { data, error } = await serviceClient().from('leads').select('id, status, assigned_to, source').in('id', ids);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((row) => [row.id, row]));
}

beforeAll(async () => {
  stubSessionEnv();
  [agentA, agentB] = await Promise.all([createUser({ name: `Bulk Agent A ${TAG}` }), createUser({ name: `Bulk Agent B ${TAG}` })]);
  [ctxA, ctxAdmin] = await Promise.all([contextForUser(agentA), signInSeeded('admin').then(contextFor)]);
});

afterAll(() => unstubSessionEnv());

describe('select all matching', () => {
  it('returns the ids the Leads list filters match, scoped to the caller', async () => {
    const source = `${TAG}-match`;
    const mine = await Promise.all([createLead({ assigned_to: agentA.id, source }), createLead({ assigned_to: agentA.id, source, status: 'TO_CALL' })]);
    const theirs = await createLead({ assigned_to: agentB.id, source });
    const unassigned = await createLead({ assigned_to: null, source });

    const agentView = await listMatchingLeadIds(ctxA, { source, unassigned: true });
    expect(agentView.ids.sort()).toEqual(mine.map((l) => l.id).sort());
    expect(agentView.total).toBe(2);

    expect((await listMatchingLeadIds(ctxA, { source, statuses: ['TO_CALL'] })).ids).toEqual([mine[1].id]);
    const adminView = await listMatchingLeadIds(ctxAdmin, { source });
    expect(adminView.ids.sort()).toEqual([...mine.map((l) => l.id), theirs.id, unassigned.id].sort());
    expect((await listMatchingLeadIds(ctxAdmin, { source, unassigned: true })).ids).toEqual([unassigned.id]);
    expect((await listMatchingLeadIds(ctxAdmin, { source, agentId: agentB.id })).ids).toEqual([theirs.id]);
    await expect(listMatchingLeadIds(null, { source })).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('status', () => {
  it('moves the agent\'s own leads, reports locked and missing ones, and undo reverts only unchanged leads', async () => {
    const a = await createLead({ assigned_to: agentA.id, status: 'NEW' });
    const b = await createLead({ assigned_to: agentA.id, status: 'NO_ANSWER' });
    const dnc = await createLead({ assigned_to: agentA.id, status: 'DO_NOT_CONTACT' });
    const theirs = await createLead({ assigned_to: agentB.id, status: 'NEW' });

    const result = await bulkUpdateStatus(ctxA, [a.id, b.id, dnc.id, theirs.id, a.id], 'INTERESTED');
    expect(result).toMatchObject({ requested: 4, updated: 2, locked: 1, unchanged: 0, missing: 1 });
    expect(result.undo?.groups).toEqual(
      expect.arrayContaining([
        { status: 'NEW', ids: [a.id] },
        { status: 'NO_ANSWER', ids: [b.id] },
      ]),
    );
    const after = await leadRows([a.id, b.id, dnc.id, theirs.id]);
    expect([after[a.id].status, after[b.id].status, after[dnc.id].status, after[theirs.id].status]).toEqual([
      'INTERESTED',
      'INTERESTED',
      'DO_NOT_CONTACT',
      'NEW',
    ]);

    // b changes again before the undo: the undo leaves it alone.
    await serviceClient().from('leads').update({ status: 'CLIENT' }).eq('id', b.id);
    expect(await undoBulkStatus(ctxA, result.undo)).toEqual({ restored: 1, skipped: 1, failed: 0 });
    const undone = await leadRows([a.id, b.id]);
    expect(undone[a.id].status).toBe('NEW');
    expect(undone[b.id].status).toBe('CLIENT');
  });

  it('validates the selection and the status', async () => {
    const lead = await createLead({ assigned_to: agentA.id });
    await expect(bulkUpdateStatus(ctxA, [], 'NEW')).rejects.toMatchObject({ code: 'validation' });
    await expect(bulkUpdateStatus(ctxA, ['not-a-uuid'], 'NEW')).rejects.toMatchObject({ code: 'validation' });
    await expect(bulkUpdateStatus(ctxA, [lead.id], 'WON')).rejects.toMatchObject({ code: 'validation' });
    const tooMany = Array.from({ length: 5001 }, () => randomUUID());
    await expect(bulkUpdateStatus(ctxA, tooMany, 'NEW')).rejects.toMatchObject({ code: 'validation' });
    // A forged undo can do no more than a bulk action: another agent's lead stays put.
    const theirs = await createLead({ assigned_to: agentB.id, status: 'CLIENT' });
    expect(await undoBulkStatus(ctxA, { kind: 'status', applied: 'CLIENT', groups: [{ status: 'NEW', ids: [theirs.id] }] })).toEqual({
      restored: 0,
      skipped: 1,
      failed: 0,
    });
  });
});

describe('admin-only actions refuse agents', () => {
  it('assign, source and delete are forbidden for an agent and change nothing', async () => {
    const lead = await createLead({ assigned_to: agentA.id, source: `${TAG}-keep` });
    await expect(bulkAssign(ctxA, [lead.id], agentB.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(bulkAssign(ctxA, [lead.id], null)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(bulkSetSource(ctxA, [lead.id], 'hijacked')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(bulkDelete(ctxA, [lead.id])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(undoBulkAssign(ctxA, { kind: 'assign', applied: agentA.id, groups: [{ assignedTo: agentB.id, ids: [lead.id] }] })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await leadRows([lead.id]))[lead.id]).toMatchObject({ assigned_to: agentA.id, source: `${TAG}-keep` });
  });
});

describe('assignment (admin)', () => {
  it('assigns unassigned and other agents\' leads, and undo gives each back to its previous owner', async () => {
    const unassigned = await createLead({ assigned_to: null });
    const fromB = await createLead({ assigned_to: agentB.id });
    const already = await createLead({ assigned_to: agentA.id });
    const open = await createFollowUp({ lead_id: fromB.id, user_id: agentB.id });

    const result = await bulkAssign(ctxAdmin, [unassigned.id, fromB.id, already.id], agentA.id);
    expect(result).toMatchObject({ requested: 3, updated: 2, unchanged: 1, missing: 0 });
    const { data: movedFollowUp } = await serviceClient().from('follow_ups').select('user_id').eq('id', open.id).single();
    expect(movedFollowUp?.user_id).toBe(agentA.id);

    expect(await undoBulkAssign(ctxAdmin, result.undo)).toEqual({ restored: 2, skipped: 0, failed: 0 });
    const back = await leadRows([unassigned.id, fromB.id, already.id]);
    expect(back[unassigned.id].assigned_to).toBeNull();
    expect(back[fromB.id].assigned_to).toBe(agentB.id);
    expect(back[already.id].assigned_to).toBe(agentA.id);
  });

  it('refuses an inactive target; undo leaves leads whose previous owner can no longer take them', async () => {
    const leaving = await createUser({ name: `Bulk Leaving ${TAG}` });
    const lead: Lead = await createLead({ assigned_to: leaving.id });
    const result = await bulkAssign(ctxAdmin, [lead.id], agentA.id);
    await disableUser(leaving.id);
    await expect(bulkAssign(ctxAdmin, [lead.id], leaving.id)).rejects.toMatchObject({ code: 'validation' });
    expect(await undoBulkAssign(ctxAdmin, result.undo)).toEqual({ restored: 0, skipped: 0, failed: 1 });
    expect((await leadRows([lead.id]))[lead.id].assigned_to).toBe(agentA.id);
  });
});

describe('follow-ups', () => {
  it('schedules on every selected lead the agent owns, then clears them', async () => {
    const withOpen = await createLead({ assigned_to: agentA.id });
    await createFollowUp({ lead_id: withOpen.id, user_id: agentA.id, due_at: new Date(Date.now() + DAY).toISOString() });
    const without = await createLead({ assigned_to: agentA.id });
    const theirs = await createLead({ assigned_to: agentB.id });

    const due = new Date(Date.now() + 3 * DAY).toISOString();
    expect(await bulkScheduleFollowUp(ctxA, [withOpen.id, without.id, theirs.id], due, 'Bulk note')).toEqual({
      requested: 3,
      created: 1,
      rescheduled: 1,
      missing: 1,
    });
    await expect(bulkScheduleFollowUp(ctxA, [without.id], new Date(Date.now() - 3 * DAY).toISOString())).rejects.toMatchObject({ code: 'validation' });

    expect(await bulkCompleteFollowUps(ctxA, [withOpen.id, without.id, theirs.id])).toEqual({ requested: 3, count: 2 });
    const { data } = await serviceClient().from('leads').select('next_follow_up_at').in('id', [withOpen.id, without.id]);
    expect((data ?? []).map((row) => row.next_follow_up_at)).toEqual([null, null]);
  });
});

describe('source and delete (admin)', () => {
  it('sets and clears the source, and hard-deletes the selection', async () => {
    const a = await createLead({ assigned_to: agentA.id, source: 'Old' });
    const b = await createLead({ assigned_to: null });
    expect(await bulkSetSource(ctxAdmin, [a.id, b.id], `  ${TAG} list `)).toEqual({ requested: 2, count: 2, source: `${TAG} list` });
    expect(await bulkSetSource(ctxAdmin, [a.id], '')).toEqual({ requested: 1, count: 1, source: null });

    expect(await bulkDelete(ctxAdmin, [a.id, b.id, randomUUID()])).toEqual({ requested: 3, count: 2 });
    expect(await leadRows([a.id, b.id])).toEqual({});
  });
});

describe('POST /api/leads/export (selected leads)', () => {
  const env = { APP_BASE_URL };
  const post = (ids: string, token: string, origin = APP_BASE_URL) =>
    handleSelectedLeadsExport(
      new Request(`${APP_BASE_URL}/api/leads/export`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ids }).toString(),
      }),
      { env },
    );

  it("exports exactly the selected leads the caller may see, and refuses a cross-site post", async () => {
    const session = await signInAs(agentA.email, agentA.password);
    const picked = await createLead({ assigned_to: agentA.id, business_name: `${TAG} Picked Co` });
    const notPicked = await createLead({ assigned_to: agentA.id, business_name: `${TAG} Not Picked Co` });
    const theirs = await createLead({ assigned_to: agentB.id, business_name: `${TAG} Their Co` });

    const res = await post(`${picked.id},${theirs.id}`, session.accessToken);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="funnel-mcqueen-leads/);
    const csv = await res.text();
    expect(csv).toContain(picked.business_name);
    expect(csv).not.toContain(notPicked.business_name);
    expect(csv).not.toContain(theirs.business_name);

    expect((await post(picked.id, session.accessToken, 'https://evil.example')).status).toBe(403);
    expect((await post('', session.accessToken)).status).toBe(400);
    expect((await post('nope', session.accessToken)).status).toBe(400);
  });
});

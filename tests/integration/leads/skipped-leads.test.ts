// Skipped queue through the service layer with real sessions (docs/DEVIATIONS.md D42): a skip is saved and
// keeps the lead out of Next Lead, lists and counts are scoped like follow-ups, the existing lead actions close
// the skip, and Resume puts the lead back in the queue.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '@/server/context';
import { reassignLead, setNextFollowUp, updateLeadStatus } from '@/server/services/leads';
import { nextLead } from '@/server/services/next-lead';
import {
  countSkippedLeads,
  getLeadSkipHistory,
  listSkippedLeads,
  resumeSkippedLead,
  skipLead,
} from '@/server/services/skipped-leads';
import { contextFor, contextForUser } from '../../helpers/context';
import { createLead, createUser, type FixtureUser } from '../../helpers/fixtures';
import { signInSeeded } from '../../helpers/seeded';

const TAG = `SKIP${randomUUID().slice(0, 8)}`;
const DAY = 86_400_000;

let agentA: FixtureUser;
let agentB: FixtureUser;
let ctxA: RequestContext;
let ctxB: RequestContext;
let ctxAdmin: RequestContext;

beforeAll(async () => {
  [agentA, agentB] = await Promise.all([createUser({ name: `Skip Agent A ${TAG}` }), createUser({ name: `Skip Agent B ${TAG}` })]);
  [ctxA, ctxB, ctxAdmin] = await Promise.all([contextForUser(agentA), contextForUser(agentB), signInSeeded('admin').then(contextFor)]);
});

describe('skipping and resuming', () => {
  it('saves the skip, keeps the lead out of Next Lead, lists it, and Resume brings it back', async () => {
    const lead = await createLead({ assigned_to: agentA.id, business_name: `${TAG} Queue Co`, status: 'NEW' });
    expect((await nextLead(ctxA))?.leadId).toBe(lead.id);

    const { skipId } = await skipLead(ctxA, lead.id, { reason: 'NEEDS_RESEARCH', note: '  check the menu  ' });
    expect(skipId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await nextLead(ctxA)).toBeNull();
    expect(await countSkippedLeads(ctxA)).toBe(1);

    const list = await listSkippedLeads(ctxA, 1);
    expect(list.total).toBe(1);
    expect(list.rows[0]).toMatchObject({
      leadId: lead.id,
      businessName: lead.business_name,
      reason: 'NEEDS_RESEARCH',
      note: 'check the menu',
      assignedTo: null,
      ownerName: null,
    });

    expect(await resumeSkippedLead(ctxA, lead.id)).toEqual({ leadId: lead.id, resumed: 1 });
    expect((await nextLead(ctxA))?.leadId).toBe(lead.id);
    expect(await countSkippedLeads(ctxA)).toBe(0);
    await expect(resumeSkippedLead(ctxA, lead.id)).rejects.toMatchObject({ code: 'not_found' });

    const history = await getLeadSkipHistory(ctxA, lead.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ reason: 'NEEDS_RESEARCH', resolution: 'RESUMED', skippedBy: null });
  });

  it("another agent can neither skip nor see someone else's skipped lead; an admin sees who skipped it", async () => {
    const lead = await createLead({ assigned_to: agentA.id, business_name: `${TAG} Private Co` });
    await expect(skipLead(ctxB, lead.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(skipLead(ctxA, lead.id, { reason: 'LATER' })).rejects.toMatchObject({ code: 'validation' });
    await skipLead(ctxA, lead.id, { reason: 'BAD_DATA' });

    expect(await getLeadSkipHistory(ctxB, lead.id)).toEqual([]);
    expect((await listSkippedLeads(ctxB)).rows.some((row) => row.leadId === lead.id)).toBe(false);
    await expect(resumeSkippedLead(ctxB, lead.id)).rejects.toMatchObject({ code: 'not_found' });

    const adminHistory = await getLeadSkipHistory(ctxAdmin, lead.id);
    expect(adminHistory[0]).toMatchObject({ reason: 'BAD_DATA', resolvedAt: null, skippedBy: `Skip Agent A ${TAG}` });
    const adminRow = (await listSkippedLeads(ctxAdmin, 1)).rows.find((row) => row.leadId === lead.id);
    // The admin list pages the whole team, so this lead may be on a later page; when it is here it carries the owner.
    if (adminRow) expect(adminRow).toMatchObject({ ownerName: `Skip Agent A ${TAG}`, assignedTo: agentA.id });
    expect(await countSkippedLeads(ctxAdmin)).toBeGreaterThanOrEqual(1);
  });
});

describe('queue actions close the skip through the existing lead actions', () => {
  it('changing the status, scheduling a follow-up or reassigning closes it', async () => {
    const byStatus = await createLead({ assigned_to: agentA.id, status: 'NEW' });
    const byFollowUp = await createLead({ assigned_to: agentA.id });
    const byReassign = await createLead({ assigned_to: agentA.id });
    for (const lead of [byStatus, byFollowUp, byReassign]) await skipLead(ctxA, lead.id);

    await updateLeadStatus(ctxA, byStatus.id, 'NOT_INTERESTED');
    await setNextFollowUp(ctxA, byFollowUp.id, new Date(Date.now() + DAY).toISOString());
    await reassignLead(ctxAdmin, byReassign.id, agentB.id);

    expect((await getLeadSkipHistory(ctxA, byStatus.id))[0]).toMatchObject({ resolution: 'STATUS_CHANGED' });
    expect((await getLeadSkipHistory(ctxA, byFollowUp.id))[0]).toMatchObject({ resolution: 'FOLLOW_UP' });
    expect((await getLeadSkipHistory(ctxAdmin, byReassign.id))[0]).toMatchObject({ resolution: 'REASSIGNED' });
    expect(await getLeadSkipHistory(ctxB, byReassign.id)).toEqual([]);
  });
});

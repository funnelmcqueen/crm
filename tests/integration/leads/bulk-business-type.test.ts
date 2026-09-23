// Bulk business type from the Leads list (docs/DEVIATIONS.md D46): admins set or clear it on a selection; agents cannot.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '@/server/context';
import { bulkSetBusinessType } from '@/server/services/bulk-leads';
import { contextFor, contextForUser } from '../../helpers/context';
import { createLead, createUser, type FixtureUser } from '../../helpers/fixtures';
import { signInSeeded } from '../../helpers/seeded';

const TAG = `BBT${randomUUID().slice(0, 8)}`;
let agent: FixtureUser;
let ctxAgent: RequestContext;
let ctxAdmin: RequestContext;

beforeAll(async () => {
  agent = await createUser({ name: `Bulk Type Agent ${TAG}` });
  [ctxAgent, ctxAdmin] = await Promise.all([contextForUser(agent), signInSeeded('admin').then(contextFor)]);
});

describe('bulkSetBusinessType', () => {
  it('sets and clears the type for an admin', async () => {
    const leads = await Promise.all([1, 2].map((n) => createLead({ assigned_to: agent.id, business_name: `${TAG} Lead ${n}` })));
    const ids = leads.map((lead) => lead.id);

    expect(await bulkSetBusinessType(ctxAdmin, ids, 'beauty')).toEqual({ requested: 2, count: 2, businessType: 'beauty' });
    expect(await bulkSetBusinessType(ctxAdmin, ids, null)).toEqual({ requested: 2, count: 2, businessType: null });
  });

  it('refuses agents and unknown types', async () => {
    const lead = await createLead({ assigned_to: agent.id, business_name: `${TAG} Solo` });
    await expect(bulkSetBusinessType(ctxAgent, [lead.id], 'auto')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(bulkSetBusinessType(ctxAdmin, [lead.id], 'dentist')).rejects.toMatchObject({ code: 'validation' });
  });
});

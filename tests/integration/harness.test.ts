// Self-check of the integration harness (global setup, clients, seeded lookups, fixtures). The
// isolation suite builds on these helpers.
import { describe, expect, it } from 'vitest';
import { anonClient, clientWithAccessToken, mintJwt, serviceClient, signInAs, trySignIn } from '../helpers/clients';
import { testStack } from '../helpers/env';
import { createCall, createFollowUp, createLead, createPhoneNumber, createUser, disableUser, fictionalPhone } from '../helpers/fixtures';
import { SEEDED_EMAILS, seededLeadId, seededPhoneNumberId, seededUserId, signInSeeded } from '../helpers/seeded';

describe('integration harness', () => {
  it('provides a seeded stack; on localbase the seed wrote the documented rows', () => {
    const stack = testStack();
    expect(stack.url).toMatch(/^https?:\/\//);
    if (stack.kind === 'localbase') {
      expect(stack.jwtSecret).toBeTruthy();
      expect(stack.seedCounts).toEqual({
        users: 5,
        phoneNumbers: 3,
        leads: 45,
        calls: 58,
        openFollowUps: 15,
        completedFollowUps: 4,
        voicemails: 2,
      });
    }
  });

  it('signs in every active seeded user with a real JWT, and refuses the disabled one', async () => {
    for (const key of ['admin', 'alex', 'blair', 'casey'] as const) {
      const user = await signInSeeded(key);
      expect(user.userId).toBe(await seededUserId(key));
      expect(user.accessToken.split('.')).toHaveLength(3);
    }
    const dana = await trySignIn(SEEDED_EMAILS.dana);
    expect(dana.user).toBeNull();
    expect(dana.error).not.toBeNull();
  });

  it('runs RLS with the signed-in session and resolves seeded rows', async () => {
    const alex = await signInSeeded('alex');
    const { data, error } = await alex.client.from('leads').select('id, assigned_to');
    expect(error).toBeNull();
    expect(data?.length).toBe(12);
    expect(new Set(data?.map((l) => l.assigned_to))).toEqual(new Set([alex.userId]));
    expect(data?.map((l) => l.id)).toContain(await seededLeadId('alex-06'));
    expect(await seededPhoneNumberId('pool')).toMatch(/^[0-9a-f-]{36}$/);
    expect((await anonClient().from('leads').select('id')).error?.code).toBe('42501');
  });

  it('creates fixtures, and a disabled user with a still-valid token gets zero rows', async () => {
    const agent = await createUser({ timezone: 'America/Chicago' });
    const lead = await createLead({ assigned_to: agent.id, phone: fictionalPhone() });
    await createFollowUp({ lead_id: lead.id, user_id: agent.id });
    await createCall({ lead_id: lead.id, user_id: agent.id, outcome: 'CONNECTED' });
    const number = await createPhoneNumber({ assigned_to: agent.id });
    expect(number.e164).toMatch(/^\+1[2-9]\d{2}55501\d{2}$/);

    const session = await signInAs(agent.email, agent.password);
    expect((await session.client.from('leads').select('id')).data).toEqual([{ id: lead.id }]);
    expect((await session.client.from('follow_ups').select('id')).data).toHaveLength(1);

    await disableUser(agent.id);
    const stale = clientWithAccessToken(session.accessToken);
    expect((await stale.from('leads').select('id')).data).toEqual([]);
    expect((await stale.from('profiles').select('id')).data).toEqual([]);
    expect((await trySignIn(agent.email, agent.password)).user).toBeNull();
    const { count } = await serviceClient().from('leads').select('id', { count: 'exact', head: true }).eq('assigned_to', agent.id);
    expect(count).toBe(1);
  });

  it('mints JWTs with the stack secret when available', async () => {
    const stack = testStack();
    if (!stack.jwtSecret) return;
    const forged = await mintJwt({ role: 'authenticated', sub: await seededUserId('alex') }, { secret: 'not-the-real-secret-but-long-enough-000' });
    const { error } = await clientWithAccessToken(forged).from('leads').select('id');
    expect(error).not.toBeNull();
  });
});

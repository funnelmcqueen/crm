// The admin RPCs behind the Agents pages refuse a signed-in agent with 42501 and leak nothing, through PostgREST
// with a real agent session (not only through the services' requireAdmin check).
import { beforeAll, describe, expect, it } from 'vitest';
import { signInAs, type SignedInUser } from '../../helpers/clients';
import { createCall, createLead, createUser, type FixtureUser } from '../../helpers/fixtures';

let agent: FixtureUser;
let other: FixtureUser;
let agentSession: SignedInUser;

const from = new Date(Date.now() - 86_400_000).toISOString();
const to = new Date(Date.now() + 86_400_000).toISOString();

beforeAll(async () => {
  [agent, other] = await Promise.all([createUser({ name: 'RPC Denial Agent' }), createUser({ name: 'RPC Denial Other' })]);
  const lead = await createLead({ assigned_to: other.id });
  await createCall({ lead_id: lead.id, user_id: other.id, outcome: 'INTERESTED' });
  agentSession = await signInAs(agent.email, agent.password);
});

describe('admin agent RPCs for an agent session', () => {
  it('admin_agent_activity raises 42501 for another agent and for the agent themselves', async () => {
    for (const target of [other.id, agent.id]) {
      const { data, error } = await agentSession.client.rpc('admin_agent_activity', {
        p_user_id: target,
        p_from: from,
        p_to: to,
      });
      expect(data).toBeNull();
      expect(error?.code).toBe('42501');
      expect(JSON.stringify(error)).not.toContain(other.email);
    }
  });

  it('admin_agent_activity gives the same 42501 for an unknown user (no existence oracle)', async () => {
    const { data, error } = await agentSession.client.rpc('admin_agent_activity', {
      p_user_id: '00000000-0000-4000-8000-000000000000',
      p_from: from,
      p_to: to,
    });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });

  it('admin_agent_rows raises 42501', async () => {
    const { data, error } = await agentSession.client.rpc('admin_agent_rows');
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });
});

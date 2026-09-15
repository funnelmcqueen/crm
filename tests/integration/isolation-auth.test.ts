// SPEC 13 isolation at the edges: anonymous callers, forged or tampered JWTs, signup, and a
// disabled agent who still holds a valid access token.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { anonClient, clientWithAccessToken, mintJwt, serviceClient, trySignIn, type SignedInUser } from '../helpers/clients';
import { testStack } from '../helpers/env';
import {
  createCall,
  createFollowUp,
  createLead,
  createPhoneNumber,
  createUser,
  fakeTwilioSid,
  FIXTURE_PASSWORD,
  PERMANENT_BAN,
  uniqueEmail,
} from '../helpers/fixtures';
import {
  API_TABLES,
  expectEmptyRows,
  expectError,
  expectNoRowsAffected,
  rpcProbes,
  signInWithTokens,
  tamperJwtPayload,
  untypedClient,
  unsignedJwt,
} from '../helpers/isolation';
import { seededLeadId, seededUserId, signInSeeded } from '../helpers/seeded';

const WRONG_SECRET = 'this-is-not-the-project-jwt-secret-at-all-000';

let alex: SignedInUser;
let blairId: string;
let blairLeadId: string;

beforeAll(async () => {
  alex = await signInSeeded('alex');
  blairId = await seededUserId('blair');
  blairLeadId = await seededLeadId('blair-01');
});

describe('anonymous (not signed in)', () => {
  it('every table is denied or empty', async () => {
    const anon = untypedClient();
    for (const table of API_TABLES) {
      const result = await anon.from(table).select('id');
      if (result.error) expect(result.error.code).toBe('42501');
      else expect(result.data).toEqual([]);
      const counted = await anon.from(table).select('id', { count: 'exact', head: true });
      if (!counted.error) expect(counted.count ?? 0).toBe(0);
    }
    expectError(await anon.from('leads').select('id').eq('id', blairLeadId), '42501');
    expectError(await anon.from('leads').insert({ business_name: 'Anon', phone: '+12125550199' }).select('id'));
    expectNoRowsAffected(await anon.from('leads').update({ notes: 'anon' }).eq('id', blairLeadId).select('id'));
    expectNoRowsAffected(await anon.from('profiles').update({ role: 'ADMIN' }).eq('id', blairId).select('id'));
  });

  it('every RPC is denied except get_company_name', async () => {
    const anon = untypedClient();
    for (const probe of rpcProbes()) {
      const result = await anon.rpc(probe.name, probe.args);
      expect(result.error, `anon could call ${probe.name}: ${JSON.stringify(result.data)}`).not.toBeNull();
      expect(result.data ?? null).toBeNull();
    }
    const name = await anon.rpc('get_company_name');
    expect(name.error).toBeNull();
    expect(typeof name.data).toBe('string');
  });

  it('public signup is disabled', async () => {
    const email = uniqueEmail('signup');
    const { data, error } = await anonClient().auth.signUp({ email, password: FIXTURE_PASSWORD });
    expect(error).not.toBeNull();
    expect(data.session).toBeNull();
    expect((await serviceClient().from('profiles').select('id').eq('email', email)).data).toEqual([]);
  });
});

describe('forged and tampered tokens', () => {
  it("an HS256 token for B's sub signed with a wrong secret is rejected with 401", async () => {
    const forged = await mintJwt({ role: 'authenticated', sub: blairId, email: 'blair@funnelmcqueen.test' }, { secret: WRONG_SECRET });
    const client = clientWithAccessToken(forged);
    const leads = await client.from('leads').select('id');
    expect(leads.status).toBe(401);
    expectError(leads);
    const rpc = await client.rpc('get_next_lead');
    expect(rpc.status).toBe(401);
    expectError(rpc);
    expect((await anonClient().auth.getUser(forged)).error).not.toBeNull();
  });

  it('a service_role token signed with a wrong secret is rejected with 401', async () => {
    const forged = await mintJwt({ role: 'service_role', iss: 'supabase-demo' }, { secret: WRONG_SECRET });
    const client = clientWithAccessToken(forged);
    const leads = await client.from('leads').select('id');
    expect(leads.status).toBe(401);
    expectError(leads);
    const claim = await client.rpc('claim_caller_id', { p_user_id: alex.userId });
    expect(claim.status).toBe(401);
    expectError(claim);
    const admin = await client.auth.admin.listUsers();
    expect(admin.error).not.toBeNull();
    expect(admin.data.users).toEqual([]);
  });

  it('an unsigned alg=none token is rejected with 401', async () => {
    for (const claims of [{ role: 'service_role' }, { role: 'authenticated', sub: blairId }]) {
      const result = await clientWithAccessToken(unsignedJwt(claims)).from('leads').select('id');
      expect(result.status).toBe(401);
      expectError(result);
    }
  });

  it('an expired token is rejected with 401', async (ctx) => {
    if (!testStack().jwtSecret) ctx.skip();
    const expired = await mintJwt({ role: 'authenticated', sub: alex.userId }, { expiresInSeconds: -3600 });
    const result = await clientWithAccessToken(expired).from('leads').select('id');
    expect(result.status).toBe(401);
    expectError(result);
  });

  it("A's real token with a modified payload (B's sub, service_role, later exp) is rejected with 401", async () => {
    const far = Math.floor(Date.now() / 1000) + 10 * 365 * 86400;
    for (const patch of [{ sub: blairId }, { role: 'service_role' }, { exp: far }, { app_metadata: { role: 'ADMIN' } }]) {
      const tampered = tamperJwtPayload(alex.accessToken, patch);
      const client = clientWithAccessToken(tampered);
      const leads = await client.from('leads').select('id');
      expect(leads.status, `payload patch ${JSON.stringify(patch)}`).toBe(401);
      expectError(leads);
      expectError(await client.rpc('search_leads', {}));
    }
    // Sanity: the untampered token works.
    const genuine = await clientWithAccessToken(alex.accessToken).from('leads').select('id');
    expect(genuine.error).toBeNull();
    expect(genuine.data?.length).toBe(12);
  });

  it('a validly signed token only ever acts as its sub: extra admin claims and unknown subs grant nothing', async (ctx) => {
    if (!testStack().jwtSecret) ctx.skip();
    const withClaims = await mintJwt({
      role: 'authenticated',
      sub: alex.userId,
      app_metadata: { role: 'ADMIN', provider: 'email' },
      user_metadata: { role: 'ADMIN' },
      user_role: 'ADMIN',
    });
    const client = clientWithAccessToken(withClaims);
    expect((await client.from('leads').select('id')).data?.length).toBe(12);
    expect((await client.rpc('is_admin')).data).toBe(false);
    expectEmptyRows(await client.from('leads').select('id').eq('id', blairLeadId));
    expectError(await client.rpc('reassign_leads', { p_lead_ids: [blairLeadId], p_to_user_id: alex.userId }), '42501');

    const ghost = clientWithAccessToken(await mintJwt({ role: 'authenticated', sub: randomUUID() }));
    for (const table of ['leads', 'calls', 'follow_ups', 'profiles', 'phone_numbers', 'settings'] as const) {
      expectEmptyRows(await ghost.from(table).select('id'));
    }
    expectEmptyRows(await ghost.rpc('get_next_lead'));
    expectEmptyRows(await ghost.rpc('search_leads', {}));
    expectError(await ghost.rpc('log_call', { p_outcome: 'CONNECTED', p_lead_id: blairLeadId }), '42501');
  });
});

describe('disabled agent with a still-valid token', () => {
  it('gets zero rows everywhere, is refused by every RPC, and cannot sign in or refresh', async () => {
    const agent = await createUser({ name: 'Soon Disabled' });
    const lead = await createLead({ assigned_to: agent.id, status: 'NO_ANSWER', source: 'Disabled Source' });
    const number = await createPhoneNumber({ assigned_to: agent.id });
    const voicemail = await createCall({
      lead_id: lead.id,
      user_id: agent.id,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      phone_number_id: number.id,
      voicemail_recording_sid: fakeTwilioSid('RE'),
      voicemail_duration_seconds: 9,
      call_status: 'completed',
    });
    const followUp = await createFollowUp({ lead_id: lead.id, user_id: agent.id, due_at: new Date(Date.now() - 3_600_000).toISOString() });

    const session = await signInWithTokens(agent.email, agent.password);
    // Sanity before disabling.
    expect((await session.client.from('leads').select('id')).data).toEqual([{ id: lead.id }]);
    expect((await session.client.rpc('unheard_voicemail_count')).data).toBe(1);

    // The admin disable flow: profile inactive through the admin's own session, then the Auth ban.
    const admin = await signInSeeded('admin');
    const disabled = await admin.client.from('profiles').update({ active: false }).eq('id', agent.id).select('id');
    expect(disabled.error).toBeNull();
    expect(disabled.data).toEqual([{ id: agent.id }]);
    const ban = await serviceClient().auth.admin.updateUserById(agent.id, { ban_duration: PERMANENT_BAN });
    expect(ban.error).toBeNull();

    const stale = clientWithAccessToken(session.accessToken);
    for (const table of ['leads', 'calls', 'follow_ups', 'profiles', 'phone_numbers', 'settings'] as const) {
      expectEmptyRows(await stale.from(table).select('id'));
      expect((await stale.from(table).select('id', { count: 'exact', head: true })).count).toBe(0);
    }
    expectEmptyRows(await stale.from('leads').select('id').eq('id', lead.id));

    expectEmptyRows(await stale.rpc('get_next_lead'));
    expectEmptyRows(await stale.rpc('search_leads', { p_query: lead.business_name }));
    expectEmptyRows(await stale.rpc('list_lead_sources'));
    expectEmptyRows(await stale.rpc('get_lead_call_history', { p_lead_id: lead.id }));
    expectEmptyRows(await stale.rpc('list_voicemails', {}));
    expect((await stale.rpc('unheard_voicemail_count')).data).toBe(0);
    expectError(await stale.rpc('get_voicemail_recording', { p_call_id: voicemail.id, p_user_id: agent.id }), '42501');
    expect((await serviceClient().rpc('get_voicemail_recording', { p_call_id: voicemail.id, p_user_id: agent.id })).data).toBeNull();
    expect((await stale.rpc('mark_voicemail_heard', { p_call_id: voicemail.id })).data).toBe(false);
    expect((await stale.rpc('can_access_lead', { p_lead_id: lead.id })).data).toBe(false);
    expect((await stale.rpc('is_active_user')).data).toBe(false);
    expect((await stale.rpc('is_admin')).data).toBe(false);

    expectError(await stale.rpc('log_call', { p_outcome: 'CONNECTED', p_lead_id: lead.id }), '42501');
    expectError(await stale.rpc('log_call', { p_outcome: 'CONNECTED', p_call_id: voicemail.id }), '42501');
    expectError(await stale.rpc('create_outbound_call', { p_lead_id: lead.id }), '42501');
    expectError(await stale.rpc('touch_device_presence'), '42501');
    expectError(await stale.rpc('consume_rate_limit', { p_bucket: 'voice_token' }), '42501');
    expectError(await stale.rpc('reassign_leads', { p_lead_ids: [lead.id], p_to_user_id: agent.id }), '42501');

    expectNoRowsAffected(await stale.from('leads').update({ status: 'CLIENT', notes: 'after disable' }).eq('id', lead.id).select('id'));
    expectNoRowsAffected(await stale.from('profiles').update({ name: 'Still here' }).eq('id', agent.id).select('id'));
    expectNoRowsAffected(await stale.from('follow_ups').update({ completed_at: new Date().toISOString() }).eq('id', followUp.id).select('id'));
    expectNoRowsAffected(await stale.from('follow_ups').delete().eq('id', followUp.id).select('id'));
    expectError(await stale.from('follow_ups').insert({ lead_id: lead.id, user_id: agent.id, due_at: new Date().toISOString() }).select('id'), '42501');

    const service = serviceClient();
    const leadAfter = (await service.from('leads').select('status, notes, assigned_to').eq('id', lead.id).single()).data;
    expect(leadAfter).toEqual({ status: 'NO_ANSWER', notes: null, assigned_to: agent.id });
    expect((await service.from('follow_ups').select('completed_at').eq('id', followUp.id).single()).data?.completed_at).toBeNull();
    expect((await service.from('calls').select('handled_at, outcome').eq('id', voicemail.id).single()).data).toEqual({ handled_at: null, outcome: null });
    expect((await service.from('profiles').select('name, device_seen_at').eq('id', agent.id).single()).data).toEqual({ name: 'Soon Disabled', device_seen_at: null });

    // Auth: the banned user cannot use the token with GoTrue, sign in again, or refresh.
    expect((await anonClient().auth.getUser(session.accessToken)).error).not.toBeNull();
    const again = await trySignIn(agent.email, agent.password);
    expect(again.user).toBeNull();
    expect(again.error).not.toBeNull();
    const refreshed = await anonClient().auth.refreshSession({ refresh_token: session.refreshToken });
    expect(refreshed.error).not.toBeNull();
    expect(refreshed.data.session).toBeNull();
  });
});

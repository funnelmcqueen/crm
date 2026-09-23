// SPEC 7a.3 / 12 / 13: POST /api/calls/outbound pre-creates the in-app call row for an accessible lead.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleCallsOutbound, handleManualCallsOutbound } from '@/server/http/voice';
import { serviceClient, signInAs, type SignedInUser } from '../helpers/clients';
import { createCall, createLead, createUser, disableUser, fakeTwilioSid, type FixtureUser } from '../helpers/fixtures';
import { browserRequest, routeEnv, stubSessionEnv, unstubSessionEnv } from './_helpers';

const PATH = '/api/calls/outbound';

let userA: FixtureUser;
let userB: FixtureUser;
let a: SignedInUser;

beforeAll(async () => {
  stubSessionEnv();
  [userA, userB] = await Promise.all([createUser(), createUser()]);
  a = await signInAs(userA.email, userA.password);
});

afterAll(() => unstubSessionEnv());

function post(token: string | undefined, body: string | undefined, origin?: string): Promise<Response> {
  return handleCallsOutbound(browserRequest(PATH, { token, body, origin }), { env: routeEnv() });
}

function postManual(token: string | undefined, body: string | undefined, origin?: string): Promise<Response> {
  return handleManualCallsOutbound(browserRequest('/api/calls/manual-outbound', { token, body, origin }), { env: routeEnv() });
}

async function rawBody(res: Response): Promise<{ status: number; text: string }> {
  return { status: res.status, text: await res.text() };
}

describe('POST /api/calls/outbound', () => {
  it("201 { callId } for the agent's own lead, and the OUTBOUND in-app row exists", async () => {
    const lead = await createLead({ assigned_to: userA.id });
    const res = await post(a.accessToken, JSON.stringify({ leadId: lead.id }));
    expect(res.status).toBe(201);
    const { callId } = (await res.json()) as { callId: string };
    const row = await serviceClient().from('calls').select('id, lead_id, user_id, direction, mode, remote_e164, provider_call_sid, call_status, outcome').eq('id', callId).single();
    expect(row.data).toEqual({
      id: callId,
      lead_id: lead.id,
      user_id: userA.id,
      direction: 'OUTBOUND',
      mode: 'IN_APP',
      remote_e164: lead.phone,
      provider_call_sid: null,
      call_status: null,
      outcome: null,
    });
  });

  it("404 for B's lead with a body identical to a random uuid and to a malformed id, and no row is created", async () => {
    const leadOfB = await createLead({ assigned_to: userB.id });
    const unassigned = await createLead({ assigned_to: null });
    const responses = [
      await rawBody(await post(a.accessToken, JSON.stringify({ leadId: leadOfB.id }))),
      await rawBody(await post(a.accessToken, JSON.stringify({ leadId: unassigned.id }))),
      await rawBody(await post(a.accessToken, JSON.stringify({ leadId: crypto.randomUUID() }))),
      await rawBody(await post(a.accessToken, JSON.stringify({ leadId: 'not-a-uuid' }))),
      await rawBody(await post(a.accessToken, JSON.stringify({}))),
    ];
    for (const response of responses) expect(response).toEqual({ status: 404, text: '{"error":"not_found"}' });

    const rows = await serviceClient().from('calls').select('id').in('lead_id', [leadOfB.id, unassigned.id]);
    expect(rows.data).toEqual([]);
  });

  it('400 for a missing or non-JSON body', async () => {
    expect(await rawBody(await post(a.accessToken, undefined))).toEqual({ status: 400, text: '{"error":"validation"}' });
    expect((await post(a.accessToken, '{leadId:')).status).toBe(400);
  });

  it('409 do_not_contact for a DO_NOT_CONTACT lead', async () => {
    const dnc = await createLead({ assigned_to: userA.id, status: 'DO_NOT_CONTACT' });
    const res = await post(a.accessToken, JSON.stringify({ leadId: dnc.id }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict', reason: 'do_not_contact' });
  });

  it('409 call_in_progress while the agent has a live unlogged call', async () => {
    const user = await createUser();
    const session = await signInAs(user.email, user.password);
    const lead = await createLead({ assigned_to: user.id });
    await createCall({ direction: 'OUTBOUND', mode: 'IN_APP', user_id: user.id, lead_id: lead.id, provider_call_sid: fakeTwilioSid('CA'), call_status: 'in-progress' });
    const res = await post(session.accessToken, JSON.stringify({ leadId: lead.id }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict', reason: 'call_in_progress' });
  });

  it('429 after the outbound_call limit (12 per minute, enforced in create_outbound_call)', async () => {
    const user = await createUser();
    const session = await signInAs(user.email, user.password);
    const lead = await createLead({ assigned_to: user.id });
    for (let i = 0; i < 12; i += 1) {
      expect((await post(session.accessToken, JSON.stringify({ leadId: lead.id }))).status, `request ${i + 1}`).toBe(201);
    }
    const limited = await post(session.accessToken, JSON.stringify({ leadId: lead.id }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
  });

  it('401 without a session and for a disabled agent; 403 with in-app calling off or a cross-site Origin', async () => {
    const lead = await createLead({ assigned_to: userA.id });
    expect((await post(undefined, JSON.stringify({ leadId: lead.id }))).status).toBe(401);

    const disabled = await createUser();
    const disabledSession = await signInAs(disabled.email, disabled.password);
    const disabledLead = await createLead({ assigned_to: disabled.id });
    await disableUser(disabled.id);
    expect((await post(disabledSession.accessToken, JSON.stringify({ leadId: disabledLead.id }))).status).toBe(401);

    const noInApp = await createUser({ inAppCallingEnabled: false });
    const noInAppSession = await signInAs(noInApp.email, noInApp.password);
    const noInAppLead = await createLead({ assigned_to: noInApp.id });
    expect((await post(noInAppSession.accessToken, JSON.stringify({ leadId: noInAppLead.id }))).status).toBe(403);

    const crossSite = await post(a.accessToken, JSON.stringify({ leadId: lead.id }), 'https://evil.example');
    expect(await rawBody(crossSite)).toEqual({ status: 403, text: '{"error":"forbidden"}' });
    const rows = await serviceClient().from('calls').select('id').in('lead_id', [lead.id, disabledLead.id, noInAppLead.id]);
    expect(rows.data).toEqual([]);
  });
});

describe('POST /api/calls/manual-outbound', () => {
  it.each(['IN_APP', 'TEL'] as const)('creates a %s row with the normalized server destination and no lead', async (mode) => {
    const res = await postManual(a.accessToken, JSON.stringify({ phone: '(212) 555-0123', mode }));
    expect(res.status).toBe(201);
    const body = await res.json() as { callId: string };
    expect(Object.keys(body)).toEqual(['callId']);
    const { data } = await serviceClient().from('calls')
      .select('id, lead_id, user_id, direction, mode, remote_e164')
      .eq('id', body.callId).single();
    expect(data).toEqual({
      id: body.callId, lead_id: null, user_id: userA.id, direction: 'OUTBOUND', mode, remote_e164: '+12125550123',
    });
  });

  it.each([
    { phone: '123', mode: 'IN_APP' },
    { phone: '', mode: 'IN_APP' },
    { phone: '(212) 555-0123', mode: 'WRONG' },
  ])('rejects invalid manual input before creating a row: %j', async (input) => {
    const { count: before } = await serviceClient().from('calls').select('id', { count: 'exact', head: true }).eq('user_id', userA.id);
    expect(await rawBody(await postManual(a.accessToken, JSON.stringify(input)))).toEqual({ status: 400, text: '{"error":"validation"}' });
    const { count: after } = await serviceClient().from('calls').select('id', { count: 'exact', head: true }).eq('user_id', userA.id);
    expect(after).toBe(before);
  });

  it('rejects missing JSON, unauthenticated callers, disabled callers, and cross-site Origin', async () => {
    const body = JSON.stringify({ phone: '(212) 555-0123', mode: 'IN_APP' });
    expect((await postManual(a.accessToken, undefined)).status).toBe(400);
    expect((await postManual(a.accessToken, '{')).status).toBe(400);
    expect((await postManual(undefined, body)).status).toBe(401);
    expect(await rawBody(await postManual(a.accessToken, body, 'https://evil.example')))
      .toEqual({ status: 403, text: '{"error":"forbidden"}' });
    const disabled = await createUser();
    const session = await signInAs(disabled.email, disabled.password);
    await disableUser(disabled.id);
    expect((await postManual(session.accessToken, body)).status).toBe(401);
  });
});

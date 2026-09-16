// Admin phone numbers (SPEC 7d): admin-only services, Twilio verification with a fake REST client, mock mode,
// assignment and active flag persistence, and agents still unable to read phone_numbers (SPEC 1, 5).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '@/server/context';
import { parseServerEnv } from '@/server/env';
import {
  PHONE_NUMBER_MESSAGES,
  addPhoneNumber,
  assignPhoneNumber,
  deactivatePhoneNumber,
  listAssignableAgents,
  listPhoneNumbers,
  mockFindIncomingNumber,
  numberVerificationMode,
  reactivatePhoneNumber,
  resolveNumberVerifier,
  unassignPhoneNumber,
  type NumberVerifier,
} from '@/server/services/phone-numbers';
import { formatPhoneDisplay } from '@/lib/domain/phone';
import { serviceClient } from '../../helpers/clients';
import { contextFor, contextForUser } from '../../helpers/context';
import {
  createPhoneNumber,
  createUser,
  fakeTwilioSid,
  fictionalPhone,
  type FixtureUser,
  type PhoneNumber,
} from '../../helpers/fixtures';
import { signInSeeded } from '../../helpers/seeded';

const TWIML_APP_SID = `AP${'ab'.repeat(16)}`;
const createdIds = new Set<string>();

let agent: FixtureUser;
let target: FixtureUser;
let disabled: FixtureUser;
let ctxAgent: RequestContext;
let ctxAdmin: RequestContext;

beforeAll(async () => {
  [agent, target, disabled] = await Promise.all([
    createUser({ name: `Numbers Agent ${randomUUID().slice(0, 6)}` }),
    createUser({ name: `Numbers Target ${randomUUID().slice(0, 6)}` }),
    createUser({ name: `Numbers Disabled ${randomUUID().slice(0, 6)}`, active: false }),
  ]);
  [ctxAgent, ctxAdmin] = await Promise.all([contextForUser(agent), signInSeeded('admin').then(contextFor)]);
});

afterAll(async () => {
  // Numbers added here must never join the caller ID pool used by other test files.
  if (createdIds.size > 0) {
    await serviceClient().from('phone_numbers').update({ active: false }).in('id', [...createdIds]);
  }
});

interface FakeTwilio {
  verifier: NumberVerifier;
  sid: string;
  lookups: string[];
  voiceAppUpdates: Array<[string, string]>;
}

function fakeTwilio(options: { lookup?: 'found' | 'missing' | 'throw'; voiceApp?: 'ok' | 'throw'; sid?: string } = {}): FakeTwilio {
  const sid = options.sid ?? fakeTwilioSid('PN');
  const lookups: string[] = [];
  const voiceAppUpdates: Array<[string, string]> = [];
  return {
    sid,
    lookups,
    voiceAppUpdates,
    verifier: {
      mode: 'twilio',
      twimlAppSid: TWIML_APP_SID,
      rest: {
        async findIncomingNumber(e164) {
          lookups.push(e164);
          if (options.lookup === 'throw') throw new Error('Twilio number lookup failed with HTTP 500');
          if (options.lookup === 'missing') return null;
          return { sid, phoneNumber: e164, voiceApplicationSid: null };
        },
        async setIncomingNumberVoiceApp(numberSid, appSid) {
          voiceAppUpdates.push([numberSid, appSid]);
          if (options.voiceApp === 'throw') throw new Error('Twilio number update failed with HTTP 500');
        },
      },
    },
  };
}

async function storedByE164(e164: string) {
  const { data, error } = await serviceClient()
    .from('phone_numbers')
    .select('id, e164, twilio_sid, label, active, assigned_to')
    .eq('e164', e164);
  if (error) throw error;
  for (const row of data ?? []) createdIds.add(row.id);
  return data ?? [];
}

async function storedById(id: string) {
  const { data } = await serviceClient()
    .from('phone_numbers')
    .select('id, e164, twilio_sid, label, active, assigned_to, last_used_at')
    .eq('id', id)
    .maybeSingle();
  return data;
}

/** A fixture number outside the pool (assigned and inactive) unless overridden. */
async function parkedNumber(overrides: Partial<PhoneNumber> = {}): Promise<PhoneNumber> {
  const number = await createPhoneNumber({ assigned_to: agent.id, active: false, ...overrides });
  createdIds.add(number.id);
  return number;
}

describe('agents are forbidden from every phone number service and change nothing', () => {
  it('list, add, assign, unassign, deactivate and reactivate', async () => {
    const number = await parkedNumber({ assigned_to: target.id, active: true });
    const before = await storedById(number.id);
    const twilio = fakeTwilio();
    const e164 = fictionalPhone();

    await expect(listPhoneNumbers(ctxAgent)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(listAssignableAgents(ctxAgent)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(addPhoneNumber(ctxAgent, { e164, label: 'x' }, { verifier: twilio.verifier })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(addPhoneNumber(ctxAgent, { e164, label: 'x' }, { verifier: { mode: 'mock' } })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(assignPhoneNumber(ctxAgent, number.id, agent.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(unassignPhoneNumber(ctxAgent, number.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(deactivatePhoneNumber(ctxAgent, number.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(reactivatePhoneNumber(ctxAgent, number.id)).rejects.toMatchObject({ code: 'forbidden' });

    expect(twilio.lookups).toEqual([]);
    expect(twilio.voiceAppUpdates).toEqual([]);
    expect(await storedByE164(e164)).toEqual([]);
    expect(await storedById(number.id)).toEqual(before);
    await serviceClient().from('phone_numbers').update({ active: false }).eq('id', number.id);
  });

  it('refuses a missing context as unauthorized', async () => {
    await expect(listPhoneNumbers(null)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(addPhoneNumber(null, { e164: fictionalPhone() }, { verifier: { mode: 'mock' } })).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});

describe('addPhoneNumber with Twilio (fake REST client)', () => {
  it('rejects a number that is not in the Twilio account and inserts nothing', async () => {
    const e164 = fictionalPhone();
    const twilio = fakeTwilio({ lookup: 'missing' });
    await expect(addPhoneNumber(ctxAdmin, { e164, label: 'Missing' }, { verifier: twilio.verifier })).rejects.toMatchObject({
      code: 'validation',
      message: 'That number was not found in your Twilio account',
    });
    expect(twilio.lookups).toEqual([e164]);
    expect(twilio.voiceAppUpdates).toEqual([]);
    expect(await storedByE164(e164)).toEqual([]);
  });

  it('stores the Twilio SID and points the number at TWILIO_TWIML_APP_SID', async () => {
    const e164 = fictionalPhone();
    const twilio = fakeTwilio();
    // Formatted input is normalized to E.164 before the lookup.
    const record = await addPhoneNumber(ctxAdmin, { e164: formatPhoneDisplay(e164), label: '  Main line  ' }, { verifier: twilio.verifier });
    createdIds.add(record.id);
    // Park it right away so it never serves as a pool caller ID for other test files.
    await serviceClient().from('phone_numbers').update({ active: false }).eq('id', record.id);

    expect(record).toMatchObject({ e164, twilioSid: twilio.sid, label: 'Main line', active: true, assignedTo: null });
    expect(twilio.lookups).toEqual([e164]);
    expect(twilio.voiceAppUpdates).toEqual([[twilio.sid, TWIML_APP_SID]]);
    expect(await storedByE164(e164)).toEqual([
      { id: record.id, e164, twilio_sid: twilio.sid, label: 'Main line', active: false, assigned_to: null },
    ]);

    const listed = (await listPhoneNumbers(ctxAdmin)).find((row) => row.id === record.id);
    expect(listed).toMatchObject({ e164, label: 'Main line', twilioSid: twilio.sid, assignedTo: null, assignedName: null, callsToday: 0 });
  });

  it('does not insert when the voice handler update fails', async () => {
    const e164 = fictionalPhone();
    const twilio = fakeTwilio({ voiceApp: 'throw' });
    await expect(addPhoneNumber(ctxAdmin, { e164, label: 'Broken' }, { verifier: twilio.verifier })).rejects.toMatchObject({
      code: 'unavailable',
      message: PHONE_NUMBER_MESSAGES.voiceAppFailed,
    });
    expect(twilio.voiceAppUpdates).toEqual([[twilio.sid, TWIML_APP_SID]]);
    expect(await storedByE164(e164)).toEqual([]);
  });

  it('does not insert when the lookup fails', async () => {
    const e164 = fictionalPhone();
    const twilio = fakeTwilio({ lookup: 'throw' });
    await expect(addPhoneNumber(ctxAdmin, { e164 }, { verifier: twilio.verifier })).rejects.toMatchObject({
      code: 'unavailable',
      message: PHONE_NUMBER_MESSAGES.lookupFailed,
    });
    expect(twilio.voiceAppUpdates).toEqual([]);
    expect(await storedByE164(e164)).toEqual([]);
  });

  it('answers a duplicate number (or Twilio SID) with conflict before touching Twilio', async () => {
    const existing = await parkedNumber();
    const twilio = fakeTwilio();
    await expect(addPhoneNumber(ctxAdmin, { e164: existing.e164, label: 'Again' }, { verifier: twilio.verifier })).rejects.toMatchObject({
      code: 'conflict',
      message: PHONE_NUMBER_MESSAGES.duplicate,
    });
    expect(twilio.lookups).toEqual([]);
    expect(twilio.voiceAppUpdates).toEqual([]);
    expect(await storedByE164(existing.e164)).toHaveLength(1);

    const sameSid = fakeTwilio({ sid: existing.twilio_sid });
    const other = fictionalPhone();
    await expect(addPhoneNumber(ctxAdmin, { e164: other }, { verifier: sameSid.verifier })).rejects.toMatchObject({ code: 'conflict' });
    expect(sameSid.voiceAppUpdates).toEqual([]);
    expect(await storedByE164(other)).toEqual([]);
  });

  it('rejects input that is not a phone number', async () => {
    const twilio = fakeTwilio();
    for (const bad of ['abc', '', '+1', '12', 42, null]) {
      await expect(addPhoneNumber(ctxAdmin, { e164: bad }, { verifier: twilio.verifier })).rejects.toMatchObject({ code: 'validation' });
    }
    await expect(addPhoneNumber(ctxAdmin, { e164: fictionalPhone(), label: 'x'.repeat(101) }, { verifier: twilio.verifier })).rejects.toMatchObject({
      code: 'validation',
    });
    expect(twilio.lookups).toEqual([]);
  });
});

describe('addPhoneNumber without Twilio', () => {
  it('mock mode accepts only fictional 555-01xx numbers and stores a fake PN sid', async () => {
    const e164 = fictionalPhone();
    const record = await addPhoneNumber(ctxAdmin, { e164, label: 'Mock line' }, { verifier: { mode: 'mock' } });
    createdIds.add(record.id);
    await serviceClient().from('phone_numbers').update({ active: false }).eq('id', record.id);
    expect(record.twilioSid).toMatch(/^PN[0-9a-f]{32}$/);
    expect(record.twilioSid).toBe(mockFindIncomingNumber(e164)?.sid);

    for (const real of ['+12125551234', '+14155550250', '+442071838750']) {
      await expect(addPhoneNumber(ctxAdmin, { e164: real }, { verifier: { mode: 'mock' } })).rejects.toMatchObject({
        code: 'validation',
        message: PHONE_NUMBER_MESSAGES.mockOnly,
      });
      expect(await storedByE164(real)).toEqual([]);
    }
  });

  it('refuses to add when Twilio is not configured and the driver is not mock', async () => {
    const e164 = fictionalPhone();
    await expect(addPhoneNumber(ctxAdmin, { e164 }, { verifier: { mode: 'unavailable' } })).rejects.toMatchObject({
      code: 'unavailable',
      message: PHONE_NUMBER_MESSAGES.twilioUnconfigured,
    });
    expect(await storedByE164(e164)).toEqual([]);
  });

  it('picks the verifier from the environment', () => {
    const base = {
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-key-for-tests',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
    };
    const twilio = {
      APP_BASE_URL: 'https://crm.example.com',
      TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
      TWILIO_API_KEY_SECRET: 'secret',
      TWILIO_TWIML_APP_SID: TWIML_APP_SID,
    };
    expect(numberVerificationMode(parseServerEnv({ ...base, NODE_ENV: 'test' }))).toBe('mock');
    expect(numberVerificationMode(parseServerEnv({ ...base, NODE_ENV: 'development', DIALER_DRIVER: 'mock' }))).toBe('mock');
    expect(numberVerificationMode(parseServerEnv({ ...base, NODE_ENV: 'development', DIALER_DRIVER: 'tel' }))).toBe('unavailable');
    expect(numberVerificationMode(parseServerEnv({ ...base, NODE_ENV: 'production' }))).toBe('unavailable');
    const configured = resolveNumberVerifier(parseServerEnv({ ...base, ...twilio, NODE_ENV: 'production' }));
    expect(configured).toMatchObject({ mode: 'twilio', twimlAppSid: TWIML_APP_SID });
    expect(numberVerificationMode(parseServerEnv({ ...base, ...twilio, NODE_ENV: 'development', DIALER_DRIVER: 'tel' }))).toBe('twilio');
  });
});

describe('assign, unassign, deactivate and reactivate persist', () => {
  it('walks one number through every action', async () => {
    const number = await parkedNumber({ assigned_to: agent.id, active: true, last_used_at: '2026-09-01T12:00:00.000Z' });

    const assigned = await assignPhoneNumber(ctxAdmin, number.id, target.id);
    expect(assigned).toMatchObject({ id: number.id, assignedTo: target.id, active: true });
    expect(await storedById(number.id)).toMatchObject({ assigned_to: target.id, active: true });
    const listed = (await listPhoneNumbers(ctxAdmin)).find((row) => row.id === number.id);
    const targetName = (await listAssignableAgents(ctxAdmin)).find((a) => a.id === target.id)?.name;
    expect(listed).toMatchObject({ assignedTo: target.id, assignedName: targetName, lastUsedAt: expect.any(String) });

    expect(await deactivatePhoneNumber(ctxAdmin, number.id)).toMatchObject({ active: false, assignedTo: target.id });
    expect(await storedById(number.id)).toMatchObject({ active: false, assigned_to: target.id });

    expect(await reactivatePhoneNumber(ctxAdmin, number.id)).toMatchObject({ active: true });
    expect(await storedById(number.id)).toMatchObject({ active: true });

    await deactivatePhoneNumber(ctxAdmin, number.id);
    expect(await unassignPhoneNumber(ctxAdmin, number.id)).toMatchObject({ assignedTo: null, active: false });
    expect(await storedById(number.id)).toMatchObject({ assigned_to: null, active: false });
    expect((await listPhoneNumbers(ctxAdmin)).find((row) => row.id === number.id)).toMatchObject({ assignedTo: null, assignedName: null });
  });

  it('assigns only to active agents or admins', async () => {
    const number = await parkedNumber();
    const before = await storedById(number.id);
    for (const bad of [disabled.id, randomUUID(), 'not-a-uuid', null]) {
      await expect(assignPhoneNumber(ctxAdmin, number.id, bad)).rejects.toMatchObject({
        code: 'validation',
        message: PHONE_NUMBER_MESSAGES.chooseAgent,
      });
    }
    expect(await storedById(number.id)).toEqual(before);

    const assignable = await listAssignableAgents(ctxAdmin);
    expect(assignable.some((a) => a.id === target.id)).toBe(true);
    expect(assignable.some((a) => a.id === disabled.id)).toBe(false);
  });

  it('answers unknown and malformed number ids with not_found', async () => {
    for (const id of [randomUUID(), 'nope', 42]) {
      await expect(assignPhoneNumber(ctxAdmin, id, target.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(unassignPhoneNumber(ctxAdmin, id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(deactivatePhoneNumber(ctxAdmin, id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(reactivatePhoneNumber(ctxAdmin, id)).rejects.toMatchObject({ code: 'not_found' });
    }
  });
});

describe('agents still cannot read or change phone_numbers (RLS)', () => {
  it('after numbers were added, assigned and toggled', async () => {
    const mine = await parkedNumber({ assigned_to: agent.id, active: true });
    await serviceClient().from('phone_numbers').update({ active: false }).eq('id', mine.id);

    for (const ctx of [ctxAgent, await signInSeeded('alex').then(contextFor)]) {
      const read = await ctx.supabase.from('phone_numbers').select('id, e164, assigned_to');
      expect(read.error).toBeNull();
      expect(read.data).toEqual([]);

      const count = await ctx.supabase.from('phone_numbers').select('id', { count: 'exact', head: true });
      expect(count.count ?? 0).toBe(0);

      const rpc = await ctx.supabase.rpc('admin_phone_number_rows');
      expect(rpc.error?.code).toBe('42501');
      expect(rpc.data).toBeNull();

      const update = await ctx.supabase.from('phone_numbers').update({ assigned_to: ctx.userId }).eq('id', mine.id).select('id');
      expect(update.data ?? []).toEqual([]);

      const insert = await ctx.supabase
        .from('phone_numbers')
        .insert({ e164: fictionalPhone(), twilio_sid: fakeTwilioSid('PN') })
        .select('id');
      expect(insert.error).not.toBeNull();
    }
    expect(await storedById(mine.id)).toMatchObject({ assigned_to: agent.id, active: false });
  });
});

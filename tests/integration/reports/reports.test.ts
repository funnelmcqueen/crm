// Admin reports service (SPEC 8 Reports): admin-only, local dates in the admin's timezone, exact numbers for
// fixture calls, totals consistent with rows, invalid ranges, empty ranges.
import { beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '@/server/context';
import { getReport } from '@/server/services/reports';
import { contextForUser } from '../../helpers/context';
import { createCall, createLead, createPhoneNumber, createUser, fakeTwilioSid, type FixtureUser } from '../../helpers/fixtures';

// A past day no other fixture or seed uses. Chicago is on CDT (UTC-5); Tokyo is UTC+9.
const DAY = '2025-06-10';
const CHICAGO_FROM = '2025-06-10T05:00:00.000Z';
const CHICAGO_TO = '2025-06-11T05:00:00.000Z';

let agent: FixtureUser;
let ctxAgent: RequestContext;
let ctxChicagoAdmin: RequestContext;
let ctxTokyoAdmin: RequestContext;
let numberId: string;

beforeAll(async () => {
  const [agentUser, chicagoAdmin, tokyoAdmin] = await Promise.all([
    createUser({ name: 'Report Fixture Agent' }),
    createUser({ role: 'ADMIN', timezone: 'America/Chicago' }),
    createUser({ role: 'ADMIN', timezone: 'Asia/Tokyo' }),
  ]);
  agent = agentUser;
  [ctxAgent, ctxChicagoAdmin, ctxTokyoAdmin] = await Promise.all([
    contextForUser(agent),
    contextForUser(chicagoAdmin),
    contextForUser(tokyoAdmin),
  ]);

  const lead = await createLead({ assigned_to: agent.id });
  await createLead({ assigned_to: agent.id, status: 'CLIENT' });
  // Inactive, so it never becomes a caller ID for other test files.
  const number = await createPhoneNumber({ active: false, assigned_to: agent.id, label: 'Report line' });
  numberId = number.id;

  const base = { lead_id: lead.id, user_id: agent.id };
  const inApp = (createdAt: string, extra: Record<string, unknown>) =>
    createCall({ ...base, mode: 'IN_APP', provider_call_sid: fakeTwilioSid('CA'), phone_number_id: number.id, created_at: createdAt, ...extra });

  await inApp('2025-06-10T04:59:59Z', { call_status: 'completed', outcome: 'CONNECTED', duration_seconds: 300 }); // Chicago: June 9
  await inApp(CHICAGO_FROM, { call_status: 'completed', outcome: 'INTERESTED', duration_seconds: 90 }); // first instant
  await inApp('2025-06-10T15:00:00Z', { call_status: 'no-answer', outcome: 'NO_ANSWER', duration_seconds: 0 });
  await createCall({ ...base, outcome: 'APPOINTMENT', duration_seconds: 45, created_at: '2025-06-10T16:00:00Z' });
  await createCall({ ...base, direction: 'INBOUND', mode: 'IN_APP', outcome: 'CONNECTED', duration_seconds: 60, created_at: '2025-06-10T17:00:00Z' });
  await inApp('2025-06-11T04:59:59Z', { call_status: 'completed', outcome: 'VOICEMAIL', duration_seconds: 15 }); // last second
  await inApp(CHICAGO_TO, { call_status: 'completed', outcome: 'CONNECTED', duration_seconds: 500 }); // Chicago: June 11
});

describe('getReport', () => {
  it('is forbidden for agents and needs a session', async () => {
    await expect(getReport(ctxAgent, { from: DAY, to: DAY })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getReport(null, { from: DAY, to: DAY })).rejects.toMatchObject({ code: 'unauthorized' });
    for (const fn of ['admin_report_agents', 'admin_report_numbers', 'admin_report_totals'] as const) {
      const { data, error } = await ctxAgent.supabase.rpc(fn, { p_from: CHICAGO_FROM, p_to: CHICAGO_TO });
      expect(error?.code, fn).toBe('42501');
      expect(data, fn).toBeNull();
    }
  });

  it("interprets the dates as local midnights in the admin's timezone", async () => {
    const report = await getReport(ctxChicagoAdmin, { from: DAY, to: DAY });
    expect(report).toMatchObject({
      range: { from: DAY, to: DAY },
      days: 1,
      timezone: 'America/Chicago',
      fromIso: CHICAGO_FROM,
      toIso: CHICAGO_TO,
    });

    // Dials: the in-app calls at 05:00, 15:00, 04:59:59 next day, plus the TEL appointment.
    expect(report.agents.find((row) => row.userId === agent.id)).toEqual({
      userId: agent.id,
      name: 'Report Fixture Agent',
      active: true,
      dials: 4,
      connected: 3,
      connectRate: 0.75,
      talkSeconds: 210,
      avgCallSeconds: 52.5,
      interested: 1,
      appointments: 1,
      clients: 1,
    });
    expect(report.numbers.find((row) => row.phoneNumberId === numberId)).toMatchObject({
      label: 'Report line',
      active: false,
      dials: 3,
      answered: 2,
      answerRate: 0.6667,
    });
  });

  it('gives a different window to an admin in another timezone', async () => {
    const report = await getReport(ctxTokyoAdmin, { from: DAY, to: DAY });
    expect(report).toMatchObject({ fromIso: '2025-06-09T15:00:00.000Z', toIso: '2025-06-10T15:00:00.000Z' });
    // Tokyo's June 10 holds the calls at 04:59:59Z and 05:00:00Z only.
    expect(report.agents.find((row) => row.userId === agent.id)).toMatchObject({ dials: 2, connected: 2, talkSeconds: 390 });
  });

  it('keeps team totals equal to the sums of the rows', async () => {
    const { agents, totals } = await getReport(ctxChicagoAdmin, { from: '2025-06-01', to: '2025-06-30' });
    const sum = (key: 'dials' | 'connected' | 'talkSeconds' | 'interested' | 'appointments' | 'clients') =>
      agents.reduce((acc, row) => acc + row[key], 0);
    expect(totals).toMatchObject({
      agents: agents.length,
      dials: sum('dials'),
      connected: sum('connected'),
      talkSeconds: sum('talkSeconds'),
      interested: sum('interested'),
      appointments: sum('appointments'),
      clients: sum('clients'),
    });
    const expectedRate = totals.dials === 0 ? 0 : Math.round((totals.connected / totals.dials) * 10_000) / 10_000;
    expect(totals.connectRate).toBeCloseTo(expectedRate, 4);
  });

  it('returns zeros for a range with no calls', async () => {
    const report = await getReport(ctxChicagoAdmin, { from: '2001-01-01', to: '2001-01-07' });
    expect(report.days).toBe(7);
    expect(report.totals).toMatchObject({ dials: 0, connected: 0, connectRate: 0, talkSeconds: 0, avgCallSeconds: 0, interested: 0, appointments: 0 });
    expect(report.agents.find((row) => row.userId === agent.id)).toMatchObject({ dials: 0, connectRate: 0, avgCallSeconds: 0, clients: 1 });
    expect(report.numbers.find((row) => row.phoneNumberId === numberId)).toMatchObject({ dials: 0, answered: 0, answerRate: 0 });
  });

  it('rejects reversed, too long and malformed ranges as validation errors', async () => {
    await expect(getReport(ctxChicagoAdmin, { from: '2025-06-11', to: '2025-06-10' })).rejects.toMatchObject({
      code: 'validation',
      message: 'The start date is after the end date.',
    });
    await expect(getReport(ctxChicagoAdmin, { from: '2024-06-01', to: '2025-06-10' })).rejects.toMatchObject({
      code: 'validation',
      message: 'Pick a range of 366 days or less.',
    });
    for (const input of [{ from: 'yesterday', to: DAY }, { from: DAY }, { from: '2025-02-30', to: '2025-03-01' }, null, 'x']) {
      await expect(getReport(ctxChicagoAdmin, input)).rejects.toMatchObject({ code: 'validation' });
    }
  });
});

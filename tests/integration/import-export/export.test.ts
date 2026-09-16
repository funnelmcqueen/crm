// GET /api/leads/export (SPEC section 10) through the route core with real access tokens: RLS scope,
// the explicit owner filter for agents, admin-only agent column, filters, streaming across pages,
// formula-injection escaping and 401s.
import { randomUUID } from 'node:crypto';
import Papa from 'papaparse';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatInTz } from '@/lib/domain/time';
import { handleLeadsExport, type LeadsExportDeps } from '@/server/http/leads-export';
import { EXPORT_ASSIGNED_AGENT_HEADER, EXPORT_DATE_PATTERN, EXPORT_HEADERS } from '@/server/services/export';
import { SEED_LEADS, leadE164 } from '../../../scripts/lib/seed-data';
import { signInAs, type SignedInUser } from '../../helpers/clients';
import { createFollowUp, createLead, createUser, disableUser, type FixtureUser, type FollowUp, type Lead } from '../../helpers/fixtures';
import { signInSeeded } from '../../helpers/seeded';
import { browserRequest, stubSessionEnv, unstubSessionEnv } from '../../routes/_helpers';

interface ExportedCsv {
  status: number;
  headers: Headers;
  columns: string[];
  rows: Array<Record<string, string>>;
  text: string;
}

async function exportAs(token: string | null, query = '', deps: Partial<LeadsExportDeps> = {}): Promise<ExportedCsv> {
  const res = await handleLeadsExport(browserRequest(`/api/leads/export${query}`, { method: 'GET', token: token ?? undefined }), deps);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // TextDecoder (like Response.text()) strips a leading BOM, so check the raw bytes for it.
  const text = new TextDecoder().decode(bytes);
  if (res.status !== 200) return { status: res.status, headers: res.headers, columns: [], rows: [], text };
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
  const [columns = [], ...data] = parsed.data;
  return {
    status: res.status,
    headers: res.headers,
    columns,
    rows: data.map((cells) => Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? '']))),
    text,
  };
}

const tag = randomUUID().slice(0, 8);
const SOURCE = `Export source ${tag}`;
let agentA: FixtureUser;
let agentB: FixtureUser;
let a: SignedInUser;
let b: SignedInUser;
let admin: SignedInUser;
let a1: Lead;
let a2: Lead;
let a3: Lead;
let b1: Lead;
let unassigned: Lead;
let followUp: FollowUp;

beforeAll(async () => {
  stubSessionEnv();
  [agentA, agentB] = await Promise.all([
    createUser({ name: `Export Agent A ${tag}`, timezone: 'America/Chicago' }),
    createUser({ name: `Export Agent B ${tag}` }),
  ]);
  [a, b, admin] = await Promise.all([signInAs(agentA.email, agentA.password), signInAs(agentB.email, agentB.password), signInSeeded('admin')]);
  a1 = await createLead({
    business_name: `Export A1 ${tag}`,
    assigned_to: agentA.id,
    source: SOURCE,
    notes: '=HYPERLINK("https://evil.test","click")',
    email: '@SUM(1+1)',
    last_contacted_at: '2026-09-15T13:30:00Z',
    call_count: 4,
  });
  a2 = await createLead({ business_name: `Export A2 ${tag}`, assigned_to: agentA.id, status: 'INTERESTED', notes: '+1 then -2, "quoted"\nsecond line' });
  a3 = await createLead({ business_name: `Export A3 ${tag}`, assigned_to: agentA.id, contact_name: '-Dash Contact' });
  b1 = await createLead({ business_name: `Export B1 ${tag}`, assigned_to: agentB.id, source: SOURCE });
  unassigned = await createLead({ business_name: `Export Unassigned ${tag}`, assigned_to: null, source: SOURCE });
  followUp = await createFollowUp({ lead_id: a1.id, user_id: agentA.id, due_at: '2030-01-02T15:00:00Z' });
});

afterAll(() => unstubSessionEnv());

const names = (csv: ExportedCsv) => csv.rows.map((row) => row.Business);

describe('agent export', () => {
  it('contains only the agent\'s own leads and no Assigned agent column', async () => {
    const csv = await exportAs(a.accessToken);
    expect(csv.status).toBe(200);
    expect(csv.columns).toEqual([...EXPORT_HEADERS]);
    expect(names(csv)).toEqual([a1.business_name, a2.business_name, a3.business_name]);
    expect(csv.text).not.toContain(b1.business_name);
    expect(csv.text).not.toContain(unassigned.business_name);
    expect(csv.text).not.toContain(agentA.email);
    expect((await exportAs(b.accessToken)).rows.map((row) => row.Business)).toEqual([b1.business_name]);
  });

  it("still returns only own rows when agent A passes agent=<B id>, unassigned=1 or B's business name", async () => {
    for (const query of [`?agent=${agentB.id}`, '?unassigned=1', `?agent=${agentB.id}&source=${encodeURIComponent(SOURCE)}`]) {
      const csv = await exportAs(a.accessToken, query);
      expect(csv.status).toBe(200);
      expect(csv.text).not.toContain(b1.business_name);
      expect(csv.text).not.toContain(unassigned.business_name);
      expect(csv.columns).not.toContain(EXPORT_ASSIGNED_AGENT_HEADER);
    }
    expect(names(await exportAs(a.accessToken, `?agent=${agentB.id}`))).toEqual([a1.business_name, a2.business_name, a3.business_name]);
    expect(names(await exportAs(a.accessToken, `?q=${encodeURIComponent(b1.business_name)}`))).toEqual([]);
  });

  it('respects the leads list filters', async () => {
    expect(names(await exportAs(a.accessToken, '?status=INTERESTED'))).toEqual([a2.business_name]);
    expect(names(await exportAs(a.accessToken, '?status=new,interested'))).toEqual([a1.business_name, a2.business_name, a3.business_name]);
    expect(names(await exportAs(a.accessToken, `?q=${encodeURIComponent(a3.business_name)}`))).toEqual([a3.business_name]);
    expect(names(await exportAs(a.accessToken, `?source=${encodeURIComponent(SOURCE)}`))).toEqual([a1.business_name]);
    expect(names(await exportAs(a.accessToken, `?q=${a1.phone.slice(2)}`))).toEqual([a1.business_name]);
  });

  it('escapes formula injection in every cell but keeps valid E.164 phones as they are', async () => {
    const csv = await exportAs(a.accessToken);
    const row1 = csv.rows.find((row) => row.Business === a1.business_name);
    const row2 = csv.rows.find((row) => row.Business === a2.business_name);
    const row3 = csv.rows.find((row) => row.Business === a3.business_name);
    expect(row1?.Notes).toBe(`'=HYPERLINK("https://evil.test","click")`);
    expect(row1?.Email).toBe(`'@SUM(1+1)`);
    expect(row1?.Phone).toBe(a1.phone);
    expect(row1?.Phone.startsWith('+1')).toBe(true);
    expect(row2?.Notes).toBe(`'+1 then -2, "quoted"\nsecond line`);
    expect(row3?.Contact).toBe(`'-Dash Contact`);
    expect(csv.text).toContain(`,${a1.phone},`);
    expect(csv.text).toContain(`"'=HYPERLINK(""https://evil.test"",""click"")"`);
  });

  it('writes status labels, the call count and dates as ISO 8601 in the viewer\'s time zone', async () => {
    const csv = await exportAs(a.accessToken);
    const row1 = csv.rows.find((row) => row.Business === a1.business_name);
    expect(row1).toMatchObject({
      Status: 'New',
      'Call count': '4',
      'Last contacted': '2026-09-15T08:30:00-05:00',
      'Next follow-up': formatInTz(followUp.due_at, 'America/Chicago', EXPORT_DATE_PATTERN),
    });
    expect(row1?.['Next follow-up']).toBe('2030-01-02T09:00:00-06:00');
    expect(csv.rows.find((row) => row.Business === a2.business_name)).toMatchObject({ Status: 'Interested', 'Last contacted': '', 'Next follow-up': '' });
  });

  it('streams across several database pages without losing or repeating rows', async () => {
    for (const pageSize of [1, 2, 3]) {
      expect(names(await exportAs(a.accessToken, '', { pageSize }))).toEqual([a1.business_name, a2.business_name, a3.business_name]);
    }
  });

  it('answers with a no-store CSV attachment named for the viewer\'s local date', async () => {
    const csv = await exportAs(a.accessToken, '', { now: () => new Date('2026-09-16T03:00:00Z') });
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv.headers.get('content-disposition')).toBe('attachment; filename="funnel-mcqueen-leads-2026-09-15.csv"');
    expect(csv.headers.get('cache-control')).toBe('no-store');
  });
});

describe('admin export', () => {
  it('has every lead, including other agents\' and unassigned ones, with the Assigned agent column', async () => {
    const csv = await exportAs(admin.accessToken);
    expect(csv.columns).toEqual([...EXPORT_HEADERS, EXPORT_ASSIGNED_AGENT_HEADER]);
    const byName = new Map(csv.rows.map((row) => [row.Business, row]));
    expect(byName.get(a1.business_name)?.[EXPORT_ASSIGNED_AGENT_HEADER]).toBe(`Export Agent A ${tag}`);
    expect(byName.get(b1.business_name)?.[EXPORT_ASSIGNED_AGENT_HEADER]).toBe(`Export Agent B ${tag}`);
    expect(byName.get(unassigned.business_name)?.[EXPORT_ASSIGNED_AGENT_HEADER]).toBe('');
    const phones = new Set(csv.rows.map((row) => row.Phone));
    for (const seeded of SEED_LEADS) expect(phones.has(leadE164(seeded))).toBe(true);
  });

  it('respects the admin filters (agent, unassigned, source, status)', async () => {
    const source = `&source=${encodeURIComponent(SOURCE)}`;
    expect(names(await exportAs(admin.accessToken, `?agent=${agentA.id}`))).toEqual([a1.business_name, a2.business_name, a3.business_name]);
    expect(names(await exportAs(admin.accessToken, `?unassigned=1${source}`))).toEqual([unassigned.business_name]);
    expect(names(await exportAs(admin.accessToken, `?x=1${source}`))).toEqual([a1.business_name, b1.business_name, unassigned.business_name]);
    expect(names(await exportAs(admin.accessToken, `?agent=${agentB.id}${source}`, { pageSize: 1 }))).toEqual([b1.business_name]);
    expect(names(await exportAs(admin.accessToken, `?status=INTERESTED&agent=${agentA.id}`))).toEqual([a2.business_name]);
  });
});

describe('unauthenticated export', () => {
  it('answers 401 without a session, with a garbage token, and for a disabled agent with a still-valid token', async () => {
    const disabled = await createUser();
    const session = await signInAs(disabled.email, disabled.password);
    await disableUser(disabled.id);
    for (const token of [null, 'not-a-jwt', session.accessToken]) {
      const res = await exportAs(token);
      expect(res.status).toBe(401);
      expect(res.text).toBe('{"error":"unauthorized"}');
    }
  });
});

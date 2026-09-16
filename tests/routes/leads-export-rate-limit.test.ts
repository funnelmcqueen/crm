// GET /api/leads/export consumes the `export` rate-limit bucket, so the route cannot be looped without
// bound. Isolation is unaffected either way: the limit is keyed on the caller, and what the export
// contains is still decided by RLS and the route's explicit assigned_to filter.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleLeadsExport } from '@/server/http/leads-export';
import { serviceClient, signInAs, type SignedInUser } from '../helpers/clients';
import { createLead, createUser, type FixtureUser, type Lead } from '../helpers/fixtures';
import { browserRequest, stubSessionEnv, unstubSessionEnv } from './_helpers';

/** Matches the `export` bucket in supabase/migrations/20260915001300_review_fixes_3.sql. */
const EXPORT_LIMIT = 30;

let user: FixtureUser;
let session: SignedInUser;
let lead: Lead;

const exportNow = (token?: string) =>
  handleLeadsExport(browserRequest('/api/leads/export', { method: 'GET', token }));

/** Spends the bucket without making the requests, so the test stays fast and deterministic. */
async function fillBucket(userId: string, count: number): Promise<void> {
  const rows = Array.from({ length: count }, () => ({ user_id: userId, bucket: 'export' }));
  const { error } = await serviceClient().from('rate_limit_hits').insert(rows);
  if (error) throw new Error(`filling the export bucket failed: ${error.message}`);
}

beforeAll(async () => {
  stubSessionEnv();
  user = await createUser({ name: 'Export Limit Agent' });
  session = await signInAs(user.email, user.password);
  lead = await createLead({ assigned_to: user.id, business_name: `Export Limit Lead ${user.id.slice(0, 8)}` });
});

afterAll(() => unstubSessionEnv());

describe('GET /api/leads/export rate limit', () => {
  it('serves the export while the bucket has room', async () => {
    const res = await exportNow(session.accessToken);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(lead.business_name);
  });

  it('answers 429 rate_limited once the bucket is spent, without running the query', async () => {
    const spender = await createUser({ name: 'Export Limit Spender' });
    const spenderSession = await signInAs(spender.email, spender.password);
    await createLead({ assigned_to: spender.id });

    await fillBucket(spender.id, EXPORT_LIMIT);

    const res = await exportNow(spenderSession.accessToken);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is per caller: one agent spending their budget does not block another', async () => {
    const other = await createUser({ name: 'Export Limit Bystander' });
    const otherSession = await signInAs(other.email, other.password);
    await createLead({ assigned_to: other.id });
    expect((await exportNow(otherSession.accessToken)).status).toBe(200);
  });

  it('still answers 401 without a session, before any limit is consumed', async () => {
    const res = await exportNow();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });
});

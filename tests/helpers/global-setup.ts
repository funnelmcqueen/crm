// vitest globalSetup for the `integration` project. Starts one in-memory localbase on a free port
// and seeds it, or targets an external stack when SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY and
// SUPABASE_TEST_SERVICE_ROLE_KEY are all set (that stack must already be migrated and seeded).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import type { TestProject } from 'vitest/node';
import { startLocalbase } from '../../localbase/server';
import { SEED_ADMIN_EMAIL } from '../../scripts/lib/seed-data';
import { seed, type SeedCounts } from '../../scripts/seed';

const MIGRATIONS_DIR = path.join(fileURLToPath(new URL('../../', import.meta.url)), 'supabase', 'migrations');

function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

async function assertExternalStackSeeded(url: string, serviceRoleKey: string): Promise<void> {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.from('profiles').select('id').eq('email', SEED_ADMIN_EMAIL).limit(1);
  if (error) throw new Error(`integration setup: cannot query SUPABASE_TEST_URL (${error.message})`);
  if (!data || data.length === 0) {
    throw new Error('integration setup: the external stack is not seeded; run `npm run db:seed` against it first');
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const externalUrl = blankToUndefined(process.env.SUPABASE_TEST_URL);
  const externalAnon = blankToUndefined(process.env.SUPABASE_TEST_ANON_KEY);
  const externalService = blankToUndefined(process.env.SUPABASE_TEST_SERVICE_ROLE_KEY);
  const externalCount = [externalUrl, externalAnon, externalService].filter(Boolean).length;

  if (externalCount === 3 && externalUrl && externalAnon && externalService) {
    await assertExternalStackSeeded(externalUrl, externalService);
    project.provide('supabaseUrl', externalUrl.replace(/\/+$/, ''));
    project.provide('supabaseAnonKey', externalAnon);
    project.provide('supabaseServiceRoleKey', externalService);
    project.provide('supabaseJwtSecret', blankToUndefined(process.env.SUPABASE_TEST_JWT_SECRET) ?? null);
    project.provide('supabaseStack', 'external');
    project.provide('seedCounts', null);
    return async () => undefined;
  }
  if (externalCount > 0) {
    throw new Error(
      'integration setup: set all of SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY and SUPABASE_TEST_SERVICE_ROLE_KEY, or none of them',
    );
  }

  const localbase = await startLocalbase({ port: 0, silent: true, migrationsDir: MIGRATIONS_DIR });
  try {
    const summary = await seed({ url: localbase.url, serviceRoleKey: localbase.serviceRoleKey });
    if (summary.alreadySeeded) throw new Error('integration setup: a fresh in-memory localbase reported already seeded');

    // No HTTP request is in flight here, so reading through the raw handle is safe.
    const { rows } = await localbase.db.query<SeedCounts>(`
      select
        (select count(*)::int from public.profiles) as "users",
        (select count(*)::int from public.phone_numbers) as "phoneNumbers",
        (select count(*)::int from public.leads) as "leads",
        (select count(*)::int from public.calls) as "calls",
        (select count(*)::int from public.follow_ups where completed_at is null) as "openFollowUps",
        (select count(*)::int from public.follow_ups where completed_at is not null) as "completedFollowUps",
        (select count(*)::int from public.calls where voicemail_recording_sid is not null) as "voicemails"
    `);
    const actual = rows[0];
    const mismatches = (Object.keys(summary.counts) as Array<keyof SeedCounts>).filter(
      (key) => actual[key] !== summary.counts[key],
    );
    if (mismatches.length > 0) {
      throw new Error(
        `integration setup: seeded rows differ from the seed summary for ${mismatches.join(', ')}: ` +
          `${JSON.stringify(actual)} vs ${JSON.stringify(summary.counts)}`,
      );
    }

    project.provide('supabaseUrl', localbase.url);
    project.provide('supabaseAnonKey', localbase.anonKey);
    project.provide('supabaseServiceRoleKey', localbase.serviceRoleKey);
    project.provide('supabaseJwtSecret', localbase.jwtSecret);
    project.provide('supabaseStack', 'localbase');
    project.provide('seedCounts', actual);
  } catch (error) {
    await localbase.stop().catch(() => undefined);
    throw error;
  }

  return async () => {
    await localbase.stop();
  };
}

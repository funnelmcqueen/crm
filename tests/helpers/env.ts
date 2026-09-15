import { inject } from 'vitest';
import type { SeedCounts } from '../../scripts/seed';

export interface TestStack {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  jwtSecret: string | null;
  kind: 'localbase' | 'external';
  /** Seeded row counts verified by the global setup (localbase only). */
  seedCounts: SeedCounts | null;
}

/** Connection details provided by tests/helpers/global-setup.ts. Only valid in the integration project. */
export function testStack(): TestStack {
  return {
    url: inject('supabaseUrl'),
    anonKey: inject('supabaseAnonKey'),
    serviceRoleKey: inject('supabaseServiceRoleKey'),
    jwtSecret: inject('supabaseJwtSecret'),
    kind: inject('supabaseStack'),
    seedCounts: inject('seedCounts'),
  };
}

export function isLocalbaseStack(): boolean {
  return inject('supabaseStack') === 'localbase';
}

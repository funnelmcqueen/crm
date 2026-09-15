import 'vitest';
import type { SeedCounts } from '../../scripts/seed';

// Values the integration globalSetup (tests/helpers/global-setup.ts) passes to test workers.
declare module 'vitest' {
  export interface ProvidedContext {
    supabaseUrl: string;
    supabaseAnonKey: string;
    supabaseServiceRoleKey: string;
    /** HS256 secret for minting test JWTs; null for an external stack without SUPABASE_TEST_JWT_SECRET. */
    supabaseJwtSecret: string | null;
    supabaseStack: 'localbase' | 'external';
    /** Rows verified in the database right after seeding; null for an external (pre-seeded) stack. */
    seedCounts: SeedCounts | null;
  }
}

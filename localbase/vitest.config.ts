import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Standalone config for the emulator's own tests: npx vitest run --config localbase/vitest.config.ts
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    include: ['tests/localbase/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});

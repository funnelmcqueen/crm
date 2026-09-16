import { defineConfig, devices } from '@playwright/test';

// scripts/e2e-server.ts: in-memory seeded localbase on 54370 + `next dev` on 3170 with DIALER_DRIVER=mock.
const APP_PORT = 3170;
const baseURL = `http://localhost:${APP_PORT}`;
const isCI = Boolean(process.env.CI);
const desktopViewport = { width: 1280, height: 800 };

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  // One shared seeded database: specs run one at a time and each owns a different seeded user.
  workers: 1,
  fullyParallel: false,
  retries: isCI ? 1 : 0,
  forbidOnly: isCI,
  // next dev compiles routes on first hit, so the first visit to a page can take a while.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: 'mobile',
      testMatch: /mobile-.*\.spec\.ts$/,
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        // An iOS user agent makes the dialer resolve to tel: links (ARCHITECTURE 6).
        userAgent: devices['iPhone 13'].userAgent,
      },
    },
    {
      // Desktop by default; pipeline-followups.spec.ts switches one describe block to a phone viewport
      // with test.use, because that flow has to work both ways.
      name: 'desktop',
      testMatch: /(desktop-.*|isolation|admin-agents|export|pipeline-followups|settings-call-mode)\.spec\.ts$/,
      use: { viewport: desktopViewport },
    },
    {
      // The import spec inserts 92 leads into the shared database, which would break every spec that
      // asserts a seeded total (isolation's "45 leads in total", the agent export). Depending on the
      // other projects makes it run last whatever the file order. It never retries: a second attempt
      // would import into the database the first attempt already changed.
      name: 'import',
      testMatch: /admin-import\.spec\.ts$/,
      dependencies: ['mobile', 'desktop'],
      retries: 0,
      use: { viewport: desktopViewport },
    },
  ],
  webServer: {
    command: 'npx tsx scripts/e2e-server.ts',
    url: `${baseURL}/login`,
    wait: { stdout: /\[e2e-server\] ready on/ },
    // Locally a running e2e server is reused (its data is no longer a fresh seed); CI always starts clean.
    reuseExistingServer: !isCI,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});

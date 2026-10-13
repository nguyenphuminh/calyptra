import { defineConfig } from '@playwright/test';

// Live tier: the deployed website, the live relayer and libp2p relay, Monad testnet.
// CALYPTRA_LIVE_URL overrides the site's address (https://calyptra.space by default). Nothing local is started.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 20 * 60_000,
  expect: { timeout: 180_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report/live' }]],
  outputDir: '../../test-results/live',
  use: {
    baseURL: process.env.CALYPTRA_LIVE_URL ?? 'https://calyptra.space',
    // A click on something covered (e.g. behind a dialog) fails after a minute instead of waiting out the test.
    actionTimeout: 60_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
});

import { defineConfig } from '@playwright/test';

// Live tier (all-ref §9.22, §10.5): the deployed website, the live relayer and libp2p relay, Monad testnet.
// Stage 2 only (§11.10): the site's address is the product owner's domain, still a placeholder, so runs set
// CALYPTRA_LIVE_URL. Nothing local is started.
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
    baseURL: process.env.CALYPTRA_LIVE_URL ?? 'https://<DOMAIN>',
    // A click on something covered (e.g. behind a dialog) fails after a minute instead of waiting out the test.
    actionTimeout: 60_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
});

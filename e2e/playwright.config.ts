import { defineConfig } from '@playwright/test';
import './ui/port.ts';

// UI tier: one dev chain, one deployment, one relayer, so one worker, one test at a time.
export default defineConfig({
  testDir: './ui',
  testMatch: '**/*.spec.ts',
  globalSetup: './ui/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 300_000,
  expect: { timeout: 60_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]],
  outputDir: '../test-results',
  use: {
    baseURL: 'http://127.0.0.1:5199',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
});

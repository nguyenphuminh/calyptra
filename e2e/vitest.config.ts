import { defineProject } from 'vitest/config';

// All files share one dev chain, so they run one after another; each file deploys its own contracts.
export default defineProject({
  test: {
    name: 'integration', include: ['integration/**/*.test.ts'], environment: 'node',
    globalSetup: ['integration/global-setup.ts'], fileParallelism: false,
    testTimeout: 300_000, hookTimeout: 300_000,
  },
});

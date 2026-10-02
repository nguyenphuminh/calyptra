import { defineProject } from 'vitest/config';

// Files run one after another because witness generation and proving are CPU-heavy.
export default defineProject({
  test: {
    name: 'circuits', include: ['test/**/*.test.ts'], environment: 'node',
    fileParallelism: false, testTimeout: 120_000, hookTimeout: 120_000,
  },
});

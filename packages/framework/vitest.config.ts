import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'framework', include: ['src/**/*.test.ts'], environment: 'node' } });

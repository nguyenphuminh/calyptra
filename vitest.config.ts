import { defineConfig } from 'vitest/config';
// Each package declares its own project; `--project <name>` selects a tier (see package.json scripts).
export default defineConfig({
  test: { projects: ['{packages,apps}/*/vitest.config.ts', '{circuits,e2e}/vitest.config.ts'] },
});

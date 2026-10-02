// Runs the test tiers in dependency order and prints a summary of every result.
// npm test [-- --only a,b] [--skip c] [--fast] [--rebuild]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Fixed order = dependency order. */
export const TIERS = ['lint', 'typecheck', 'contracts-lint', 'framework', 'circuits', 'contracts', 'desktop', 'web', 'integration', 'ui'] as const;
export type Tier = (typeof TIERS)[number];
/** Tiers that need the dev node or a browser. */
export const SLOW: readonly Tier[] = ['integration', 'ui'];

interface TierCommand {
  cmd: string;
  args: string[];
  /** Skipped while this path does not exist. */
  needs?: string;
}

const COMMANDS: Record<Tier, TierCommand> = {
  lint: { cmd: 'npx', args: ['eslint', '.'] },
  typecheck: { cmd: 'npm', args: ['run', 'typecheck', '--silent'] },
  'contracts-lint': { cmd: 'sh', args: ['-c', 'cd contracts && forge fmt --check && forge lint --deny warnings'] },
  framework: { cmd: 'npx', args: ['vitest', 'run', '--project', 'framework'] },
  circuits: { cmd: 'npx', args: ['vitest', 'run', '--project', 'circuits'] },
  contracts: { cmd: 'sh', args: ['-c', 'cd contracts && forge test'] },
  desktop: { cmd: 'npx', args: ['vitest', 'run', '--project', 'desktop'], needs: 'apps/desktop' },
  web: { cmd: 'npx', args: ['vitest', 'run', '--project', 'web'], needs: 'apps/web' },
  integration: { cmd: 'npx', args: ['vitest', 'run', '--project', 'integration'] },
  ui: { cmd: 'npx', args: ['playwright', 'test', '-c', 'e2e/playwright.config.ts'], needs: 'e2e/playwright.config.ts' },
};

/** Runs the selected tiers in TIERS order (all of them, even after a failure); true when none failed. */
export function runTiers(selected: readonly string[], { rebuild = false }: { rebuild?: boolean } = {}): boolean {
  if (rebuild || !existsSync(join(REPO, 'circuits/build/fixtures/pool.json'))) {
    const setup = spawnSync(process.execPath, ['scripts/setup.ts'], { cwd: REPO, stdio: 'inherit' });
    if (setup.status !== 0) return false;
  }
  const records: { tier: Tier; status: string; seconds: string }[] = [];
  for (const tier of TIERS) {
    if (!selected.includes(tier)) continue;
    const { cmd, args, needs } = COMMANDS[tier];
    if (needs && !existsSync(join(REPO, needs))) {
      records.push({ tier, status: 'skipped (not built yet)', seconds: '-' });
      continue;
    }
    console.log(`\n=== ${tier}`);
    const started = performance.now();
    const result = spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit' });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    records.push({ tier, status: result.status === 0 ? 'passed' : 'FAILED', seconds });
  }
  console.log('\n tier            result                   time (s)');
  for (const r of records) console.log(` ${r.tier.padEnd(15)} ${r.status.padEnd(24)} ${r.seconds}`);
  return !records.some((r) => r.status === 'FAILED');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const option = (name: string): string[] => {
    const i = argv.indexOf(`--${name}`);
    const value = i >= 0 ? argv[i + 1] : undefined;
    return value ? value.split(',').filter(Boolean) : [];
  };
  const only = option('only');
  const skip = option('skip');
  const fast = argv.includes('--fast');
  const selected = (only.length ? only : [...TIERS]).filter((t) => !skip.includes(t) && !(fast && (SLOW as readonly string[]).includes(t)));
  process.exit(runTiers(selected, { rebuild: argv.includes('--rebuild') }) ? 0 : 1);
}

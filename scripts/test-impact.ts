// Runs only the test tiers affected by the changed files.
// npm run test:impact [-- --staged] [--base <ref>] [--fast] [--dry-run]
import { execFileSync } from 'node:child_process';
import { SLOW, TIERS, runTiers } from './test-all.ts';
import type { Tier } from './test-all.ts';

/** First matching rule wins (after lint/typecheck for source files). */
const RULES: readonly [RegExp, readonly Tier[]][] = [
  [/^circuits\/src\//, ['circuits', 'contracts', 'integration', 'ui']],
  [/^circuits\//, ['circuits']],
  [/^contracts\//, ['contracts-lint', 'contracts', 'integration', 'ui']],
  [/^packages\/framework\/src\/shared\/protocol\//, ['circuits', 'contracts', 'framework', 'desktop', 'web', 'integration', 'ui']],
  [/^packages\/framework\//, ['framework', 'desktop', 'web', 'integration', 'ui']],
  [/^apps\/desktop\//, ['desktop', 'integration', 'ui']],
  [/^apps\/web\//, ['web', 'ui']],
  [/^e2e\/integration\//, ['integration']],
  [/^e2e\/contracts\//, ['integration', 'ui']],
  [/^e2e\//, ['ui']],
  [/^scripts\//, ['integration', 'ui']],
  [/^(package(-lock)?\.json|tsconfig\.base\.json|eslint\.config\.js|vitest\.config\.ts)$/, TIERS],
];

/** The tiers a set of changed files can break, in TIERS order. */
export function affectedTiers(files: readonly string[]): Tier[] {
  const tiers = new Set<Tier>();
  for (const file of files) {
    if (/\.(ts|tsx|js|mjs)$/.test(file)) {
      tiers.add('lint');
      tiers.add('typecheck');
    }
    for (const t of RULES.find(([pattern]) => pattern.test(file))?.[1] ?? []) tiers.add(t);
  }
  return TIERS.filter((t) => tiers.has(t));
}

const git = (...args: string[]): string[] =>
  execFileSync('git', args, { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean);

function mergeBase(): string | undefined {
  try {
    return git('merge-base', 'HEAD', 'main')[0];
  } catch {
    return undefined;
  }
}

function changedFiles(argv: readonly string[]): string[] {
  if (argv.includes('--staged')) return git('diff', '--name-only', '--cached');
  const i = argv.indexOf('--base');
  const base = (i >= 0 ? argv[i + 1] : undefined) ?? mergeBase() ?? 'HEAD';
  return [...new Set([...git('diff', '--name-only', base), ...git('ls-files', '--others', '--exclude-standard')])];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const files = changedFiles(argv);
  let tiers = affectedTiers(files);
  if (argv.includes('--fast')) tiers = tiers.filter((t) => !SLOW.includes(t));
  console.log(`${files.length} changed file(s) -> tiers: ${tiers.join(', ') || 'none'}`);
  if (argv.includes('--dry-run') || tiers.length === 0) process.exit(0);
  process.exit(runTiers(tiers, { rebuild: files.some((f) => f.startsWith('circuits/src/')) }) ? 0 : 1);
}

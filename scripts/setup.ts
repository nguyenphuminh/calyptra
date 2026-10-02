// npm run setup [-- <circuit build args>]: circuits -> Groth16 setup -> proving artifacts and the generated
// on-chain verifier -> contract test fixtures with real proofs -> git hooks.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BINARIES = ['circom', 'forge', 'anvil', 'cast'];
// Same location the circuit build reads (circuits/scripts/build.ts).
const PTAU = process.env.CALYPTRA_PTAU ?? join(homedir(), '.local/share/calyptra-tools/ptau/ppot_0080_17.ptau');

function onPath(binary: string): boolean {
  try {
    execFileSync('which', [binary], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Runs a step in the repository with inherited output; a failing step stops the setup with its exit code. */
function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const missing = BINARIES.filter((binary) => !onPath(binary));
if (!existsSync(PTAU)) missing.push('powers of tau');
if (missing.length > 0) {
  console.error(`missing: ${missing.join(', ')}\nrun: bash scripts/setup-tools.sh && source scripts/env.sh`);
  process.exit(1);
}

console.log('\n== circuits and Groth16 setup');
run('node', ['circuits/scripts/build.ts', ...process.argv.slice(2)]);

console.log('\n== contract test fixtures (real proofs)');
run('node', ['contracts/scripts/fixtures.ts']);

run('git', ['config', 'core.hooksPath', '.githooks']);
console.log('\ngit hooks installed (.githooks): pre-commit runs affected fast tests, pre-push runs all affected tests');

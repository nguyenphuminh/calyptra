import { buildContracts } from '../../scripts/lib/deploy.ts';
import { startDevnode } from '../../scripts/lib/devnode.ts';

// Once per run: the shared dev chain, and the contracts in their short-window test build.
export default async function setup(): Promise<void> {
  await startDevnode();
  buildContracts({ e2e: true });
}

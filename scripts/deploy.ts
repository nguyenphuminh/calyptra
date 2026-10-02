// npm run deploy:devnode [-- --e2e]: deploys the test stablecoin and fresh contracts to the local dev chain
// and writes .devnode/deployment.json (read by tests, the desktop client and the website in dev).
import { writeFileSync } from 'node:fs';
import { deployCalyptra } from './lib/deploy.ts';
import { DEVNODE_DIR, devPublicClient, devWalletClient, startDevnode } from './lib/devnode.ts';
import { deployTestToken } from './lib/test-token.ts';

const e2e = process.argv.includes('--e2e');
await startDevnode();
const wallet = devWalletClient();
const client = devPublicClient();
const stablecoin = await deployTestToken(wallet, client);
const deployment = { ...(await deployCalyptra(wallet, client, stablecoin, { e2e })), e2eShortWindow: e2e };
writeFileSync(`${DEVNODE_DIR}/deployment.json`, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(JSON.stringify(deployment, null, 2));

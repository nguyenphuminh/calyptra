// Deploys the production build (3-7 day dispute window) to a public network, with that chain's real stablecoin:
//   npm run deploy:network -- --network <built-in id>      (e.g. monad-testnet)
//   npm run deploy:network -- --network-file <json>         (a custom chain configuration)
// The deployer key comes from CALYPTRA_DEPLOYER_KEY and must hold MON for the gas, billed on the declared
// limits (deployments send no MON, so Monad's 10 MON reserve does not apply).
// Paste the printed `contracts` block into the network's entry in
// packages/framework/src/modules/chain/chain.config.ts.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { BUILT_IN_NETWORKS, NetworkConfigSchema } from '../packages/framework/src/modules/chain/index.ts';
import { deployCalyptra } from './lib/deploy.ts';

const { values } = parseArgs({ options: { network: { type: 'string' }, 'network-file': { type: 'string' } } });
const file = values['network-file'];
const network = file
  ? NetworkConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  : BUILT_IN_NETWORKS.find((n) => n.id === values.network);
if (!network) {
  throw new Error(`--network must be one of ${BUILT_IN_NETWORKS.map((n) => n.id).join(', ')}, or pass --network-file`);
}
const key = process.env.CALYPTRA_DEPLOYER_KEY;
if (!key) throw new Error('Set CALYPTRA_DEPLOYER_KEY to a private key funded on the target chain');
const deployerKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'CALYPTRA_DEPLOYER_KEY must be a 0x-prefixed 32-byte hex key').parse(key) as Hex;

const chain = defineChain({
  id: network.chainId,
  name: network.name,
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [network.rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(network.rpcUrl) });
const wallet = createWalletClient({ account: privateKeyToAccount(deployerKey), chain, transport: http(network.rpcUrl) });
if ((await client.getChainId()) !== network.chainId) throw new Error(`${network.rpcUrl} is not chain ${network.chainId}`);

console.log(`deploying to ${network.name} from ${wallet.account.address}…`);
const deployment = await deployCalyptra(wallet, client, network.stablecoin as Address);
console.log(JSON.stringify({ contracts: { pool: deployment.pool, disputes: deployment.disputes, deployBlock: deployment.deployBlock } }, null, 2));

// Local demo: a dev chain with fresh contracts, the real desktop client (transaction relayer and
// libp2p relay) and the website, all on this machine.
//   npm run demo                                       local dev chain
//   npm run demo -- --testnet                          the website + a local relayer/relay on the built-in public testnet
//   npm run demo -- fund <address> [native] [stable]   local chain only: test coins and test stablecoin
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILT_IN_NETWORKS } from '@calyptra/framework';
import type { NetworkConfig } from '@calyptra/framework';
import { createPublicClient, formatEther, http, parseAbi, parseEther, parseUnits } from 'viem';
import type { Address } from 'viem';
import { english, generateMnemonic } from 'viem/accounts';
import { createServer } from 'vite';
import { desktopRpc, runDesktop, startDesktop, stopDesktop } from './lib/desktop-process.ts';
import { deployCalyptra } from './lib/deploy.ts';
import type { Deployment } from './lib/deploy.ts';
import { DEVNODE_DIR, DEVNODE_RPC, REPO, devPublicClient, devWalletClient, startDevnode } from './lib/devnode.ts';
import { deployTestToken } from './lib/test-token.ts';

const PORTS = { rpc: 8645, relayer: 8646, relay: 8647, web: 5173 };
const PASSWORD = 'calyptra-demo';
/** Relayer fees of the demo node: the §11.2 defaults (0.25 MON, 0.01 AUSD). */
const RELAYER_FEES = { native: '0.25', stablecoin: '0.01' };
/**
 * Gas money of the demo's relayer account. On Monad an account must keep a 10 MON reserve and gas is
 * billed on the declared limit (§11.2), so it holds the reserve plus room for relayed transactions.
 */
const RELAYER_FUNDING = '20';
const RELAYER_HINT = { below: parseEther('11'), send: '12' };
/** The demo merchant's offer (§11.5 placeholder prices); it runs only with a DASHSCOPE_API_KEY. */
const MERCHANT_OFFER = join(REPO, 'scripts', 'live', 'merchant-offer.json');

const argv = process.argv.slice(2);
const testnet = argv.includes('--testnet');
const publicNetwork = BUILT_IN_NETWORKS[0] as NetworkConfig;
const dir = testnet ? join(homedir(), '.calyptra-demo', publicNetwork.id) : join(DEVNODE_DIR, 'demo');
const stateFile = join(dir, 'demo.json');

interface DemoState {
  deployment?: Deployment;
  relayerAccount?: Address;
}

async function load(): Promise<DemoState> {
  return existsSync(stateFile) ? (JSON.parse(await readFile(stateFile, 'utf8')) as DemoState) : {};
}
const save = (state: DemoState): Promise<void> => writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });

const tokenAbi = parseAbi(['function mint(address to, uint256 value)', 'function decimals() view returns (uint8)']);

/** Local chain only: sends test coins from the dev account and mints test stablecoin. */
async function fund(address: Address, native = '1', stable = '1000'): Promise<void> {
  const { deployment } = await load();
  if (testnet || !deployment) throw new Error('fund works on the local chain only; run `npm run demo` first');
  const client = devPublicClient();
  const wallet = devWalletClient();
  if (Number(native) > 0) {
    await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: address, value: parseEther(native) }) });
  }
  if (Number(stable) > 0) {
    // The stablecoin's real decimals, not an assumed 6.
    const decimals = await client.readContract({ address: deployment.stablecoin, abi: tokenAbi, functionName: 'decimals' });
    const hash = await wallet.writeContract({ address: deployment.stablecoin, abi: tokenAbi, functionName: 'mint', args: [address, parseUnits(stable, decimals)] });
    await client.waitForTransactionReceipt({ hash });
  }
  console.log(`sent ${native} MON and ${stable} test stablecoin to ${address}`);
}

/** The local chain's network entry, in the framework's chain-configuration format. */
function devNetwork(deployment: Deployment): NetworkConfig {
  return {
    id: 'devnode',
    name: 'Local dev chain',
    chainId: deployment.chainId,
    rpcUrl: DEVNODE_RPC,
    stablecoin: deployment.stablecoin,
    contracts: { pool: deployment.pool, disputes: deployment.disputes, deployBlock: BigInt(deployment.deployBlock) },
    relayers: [],
    libp2pRelays: [],
  };
}

const jsonOf = (network: NetworkConfig): string =>
  JSON.stringify(network, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);

async function readToken(tokenFile: string): Promise<{ url: string; token: string }> {
  return JSON.parse(await readFile(tokenFile, 'utf8')) as { url: string; token: string };
}

async function main(): Promise<void> {
  if (argv[0] === 'fund') {
    const [, address, native, stable] = argv;
    if (!address) throw new Error('usage: npm run demo -- fund <address> [native] [stable]');
    await fund(address as Address, native, stable);
    return;
  }

  let network: NetworkConfig;
  if (testnet) {
    network = publicNetwork;
    if (!network.contracts) throw new Error(`Calyptra is not deployed on ${network.name} yet: run npm run deploy:network and add the contracts to chain.config.ts`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } else {
    await startDevnode();
    let state = await load();
    // A chain that restarted empty has none of the saved contracts: start the demo over.
    if (state.deployment && (await devPublicClient().getCode({ address: state.deployment.pool })) === undefined) {
      console.log('the local chain was reset; starting the demo over');
      await rm(dir, { recursive: true, force: true });
      state = {};
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!state.deployment) {
      console.log('deploying fresh contracts to the local chain…');
      const stablecoin = await deployTestToken(devWalletClient(), devPublicClient());
      // The e2e build accepts dispute windows from 10 s, so disputes can be tried from the desktop client.
      state.deployment = await deployCalyptra(devWalletClient(), devPublicClient(), stablecoin, { e2e: true });
      await save(state);
    }
    network = devNetwork(state.deployment);
  }
  const networkFile = join(dir, 'network.json');
  await writeFile(networkFile, jsonOf(network));

  const env = { CALYPTRA_PASSWORD: PASSWORD, CALYPTRA_SECRET: generateMnemonic(english, 128) };
  const dataDir = join(dir, 'desktop');
  const tokenFile = join(dir, 'rpc.json');
  const base = ['start', '--data-dir', dataDir, ...(testnet ? [] : ['--network-file', networkFile]), '--network', network.id, '--no-shell', '--log-level', 'warn'];
  const rpcArgs = ['--rpc', '--rpc-port', String(PORTS.rpc), '--rpc-token-file', tokenFile];

  if (!existsSync(dataDir)) {
    const init = await runDesktop(['init', '--phrase', '--data-dir', dataDir], env);
    if (init.code !== 0) throw new Error(init.stderr);
  }
  const state = await load();
  if (!state.relayerAccount) {
    // Account 2, never used for deposits, relays; account 1 is the demo node's own wallet.
    const first = await startDesktop([...base, ...rpcArgs], env);
    state.relayerAccount = (await desktopRpc<{ id: Address }>(await readToken(tokenFile), 'account.add')).id;
    await stopDesktop(first.child);
    await save(state);
    if (!testnet) await fund(state.relayerAccount, RELAYER_FUNDING, '0'); // gas money for relaying
  }
  const relayerAccount = state.relayerAccount;
  const relayerBalance = await createPublicClient({ transport: http(network.rpcUrl) }).getBalance({ address: relayerAccount });

  const desktop = await startDesktop(
    [
      ...base, ...rpcArgs,
      '--relayer', '--relayer-account', relayerAccount,
      '--relayer-fee-native', RELAYER_FEES.native, '--relayer-fee-stablecoin', RELAYER_FEES.stablecoin,
      '--relayer-host', '127.0.0.1', '--relayer-port', String(PORTS.relayer),
      '--libp2p-relay', '--libp2p-relay-host', '127.0.0.1', '--libp2p-relay-port', String(PORTS.relay),
      ...(process.env.DASHSCOPE_API_KEY ? ['--merchant', '--merchant-offer', MERCHANT_OFFER] : []),
    ],
    env,
  );
  const relayer = desktop.ready.relayer ?? '';
  const relay = desktop.ready.libp2pRelay?.[0] ?? '';
  const merchants = desktop.ready.merchant ? [desktop.ready.merchant] : [];
  if (!testnet) process.env.VITE_CALYPTRA_DEV_NETWORK = jsonOf({ ...network, relayers: [relayer], libp2pRelays: [relay], merchants });
  process.env.VITE_CALYPTRA_TICK_MS = '3000';
  const vite = await createServer({ root: join(REPO, 'apps/web'), logLevel: 'warn', server: { host: '127.0.0.1', port: PORTS.web, strictPort: true } });
  await vite.listen();

  console.log(`\nCalyptra is running. Open http://127.0.0.1:${PORTS.web} (use a second browser profile or a private window as a second user).\n`);
  if (testnet) {
    const topUp = relayerBalance < RELAYER_HINT.below ? ` — send it about ${RELAYER_HINT.send} MON first` : '';
    console.log(`Network: ${network.name} (the default for a new wallet). In Settings, add:`);
    console.log(`  transaction relayer  ${relayer}`);
    console.log(`  libp2p relay         ${relay}`);
    console.log(`Fund your wallet's address with testnet MON. The relayer account ${relayerAccount} pays the gas of`);
    console.log(`relayed transactions and holds ${formatEther(relayerBalance)} MON${topUp}`);
  } else {
    console.log('In the wallet, pick the network "Local dev chain" (top right). Its relayer and relay are already set.');
    console.log('Give a wallet test money:  npm run demo -- fund <address shown on the Public tab> [native] [stable]');
    console.log('Disputes from the website use the 7-day window; the desktop client accepts windows from 10 s.');
  }
  if (desktop.ready.merchant) {
    console.log(`\nThe Qwen AI chat merchant runs on the desktop client: http://127.0.0.1:${PORTS.web}/#/merchant/${desktop.ready.merchant}`);
  } else {
    console.log('\nSet DASHSCOPE_API_KEY to also run the Qwen AI chat merchant (per-second subscriptions).');
  }
  console.log(`\nDesktop client RPC: ${desktop.ready.rpc?.url} (token in ${tokenFile}). Its data folder password is "${PASSWORD}".`);
  console.log('Press Ctrl+C to stop.');

  process.once('SIGINT', () => {
    void Promise.all([stopDesktop(desktop.child), vite.close()]).then(() => process.exit(0)); // the dev node keeps running
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

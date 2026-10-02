// UI tier global setup (all-ref §10.4.1), in this order: the dev chain and one fresh short-window
// deployment; the real desktop client as transaction relayer and libp2p relay; the echo merchant
// (§11.5) as a framework node in this process; a production build of the website that knows the dev
// networks, served by `vite preview` on 127.0.0.1:5199.
import './port.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, preview } from 'vite';
import { parseEther, type Address } from 'viem';
import { english, generateMnemonic } from 'viem/accounts';
import { EchoServicePort, NetworkConfigSchema, OfferSchema } from '../../packages/framework/src/index.ts';
import { deployCalyptra } from '../../scripts/lib/deploy.ts';
import { desktopRpc, freePort, runDesktop, startDesktop, stopDesktop } from '../../scripts/lib/desktop-process.ts';
import { DEVNODE_RPC, REPO, devPublicClient, devWalletClient, startDevnode } from '../../scripts/lib/devnode.ts';
import { deployTestToken } from '../../scripts/lib/test-token.ts';
import { keepTicking, merchantCardOf, startPeer } from './peer.ts';

const UI_PORT = 5199;
const DESKTOP_PASSWORD = 'password123';

/** The echo merchant's offer: the §11.5 placeholder price ($0.002 per second, at least $1). */
const ECHO_OFFER = OfferSchema.parse({
  kind: 'ai-chat', title: 'Echo chat', token: 'stablecoin', ratePerSecond: '2000', minFunding: '1000000', graceSeconds: 3,
});

export default async function globalSetup(): Promise<() => Promise<void>> {
  await startDevnode();
  const client = devPublicClient();
  const dev = devWalletClient();
  const stablecoin = await deployTestToken(dev, client);
  const deployment = await deployCalyptra(dev, client, stablecoin, { e2e: true });

  const dir = await mkdtemp(join(tmpdir(), 'calyptra-ui-'));
  // Undone in reverse order at teardown, or as far as the setup got when a step fails.
  const undo: (() => Promise<unknown>)[] = [() => rm(dir, { recursive: true, force: true })];
  const teardown = async (): Promise<void> => {
    for (const step of undo.reverse()) await step().catch(() => undefined);
  };
  try {
    const network = {
      id: 'devnode', name: 'Dev node', chainId: deployment.chainId, rpcUrl: DEVNODE_RPC, stablecoin,
      contracts: { pool: deployment.pool, disputes: deployment.disputes, deployBlock: deployment.deployBlock },
      relayers: [] as string[], libp2pRelays: [] as string[],
    };
    const networkFile = join(dir, 'devnode.json');
    await writeFile(networkFile, JSON.stringify(network));

    const env = { CALYPTRA_PASSWORD: DESKTOP_PASSWORD, CALYPTRA_SECRET: generateMnemonic(english, 128) };
    const dataDir = join(dir, 'desktop');
    const init = await runDesktop(['init', '--phrase', '--data-dir', dataDir], env);
    if (init.code !== 0) throw new Error(`desktop init failed: ${init.stderr}`);
    const base = ['start', '--data-dir', dataDir, '--network-file', networkFile, '--network', network.id, '--no-shell',
      '--rpc', '--rpc-token-file', join(dir, 'rpc.json'), '--log-level', 'warn'];

    // A never-used account relays (the relayer role refuses the active account and accounts that made deposits).
    const first = await startDesktop([...base, '--rpc-port', String(await freePort())], env);
    let relayerAccount: Address;
    try {
      const rpc = first.ready.rpc;
      if (!rpc) throw new Error('the desktop client started without its RPC');
      const { token } = JSON.parse(await readFile(rpc.tokenFile, 'utf8')) as { token: string };
      relayerAccount = (await desktopRpc<{ id: Address }>({ url: rpc.url, token }, 'account.add')).id;
    } finally {
      await stopDesktop(first.child);
    }
    await client.waitForTransactionReceipt({ hash: await dev.sendTransaction({ to: relayerAccount, value: parseEther('10') }) });

    const desktop = await startDesktop([...base, '--rpc-port', String(await freePort()),
      '--relayer', '--relayer-account', relayerAccount, '--relayer-fee-native', '0.0001', '--relayer-fee-stablecoin', '0.01',
      '--relayer-host', '127.0.0.1', '--relayer-port', String(await freePort()),
      '--libp2p-relay', '--libp2p-relay-host', '127.0.0.1', '--libp2p-relay-port', String(await freePort())], env);
    undo.push(() => stopDesktop(desktop.child));
    const { relayer, libp2pRelay } = desktop.ready;
    if (!relayer || !libp2pRelay?.length) throw new Error('the desktop client started without its relayer or libp2p relay');

    const served = { ...network, relayers: [relayer], libp2pRelays: libp2pRelay };
    const merchant = await startPeer(NetworkConfigSchema.parse(served), { merchant: { offer: ECHO_OFFER, service: new EchoServicePort({ delayMs: 50 }) } });
    const stopMerchantTicks = keepTicking(merchant);
    undo.push(async () => {
      stopMerchantTicks();
      await merchant.lock();
    });
    const webNetwork = { ...served, merchants: [await merchantCardOf(merchant, ECHO_OFFER)] };
    const undeployed = { ...webNetwork, id: 'dev-undeployed', name: 'Second dev chain', contracts: undefined, relayers: [], libp2pRelays: [], merchants: [] };

    process.env.VITE_CALYPTRA_DEV_NETWORK = JSON.stringify([webNetwork, undeployed]);
    process.env.VITE_CALYPTRA_TICK_MS = '1500';
    const outDir = join(dir, 'web');
    const root = join(REPO, 'apps/web');
    await build({ root, logLevel: 'warn', build: { outDir, emptyOutDir: true, ...(process.env.CALYPTRA_UI_PROFILE ? { minify: false } : {}) } });
    const server = await preview({ root, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: UI_PORT, strictPort: true } });
    undo.push(() => new Promise<void>((resolve) => server.httpServer.close(() => resolve())));

    process.env.CALYPTRA_UI_NETWORK = JSON.stringify(webNetwork);
    return teardown;
  } catch (err) {
    await teardown();
    throw err;
  }
}

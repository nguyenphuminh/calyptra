import { zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { Calyptra, type CalyptraOptions } from './calyptra.ts';
import { createPeerNode, createRelayNode } from './libp2p.node.ts';
import { BUILT_IN_NETWORKS, defaultRpcUrls, type NetworkConfig } from './modules/chain/index.ts';
import type { ChannelDeps } from './modules/channel/index.ts';
import { EchoServicePort, MerchantService } from './modules/merchant/index.ts';
import type { PoolDeps } from './modules/pool/index.ts';
import type { RelayerInfo, RelayerPort } from './modules/relayer/index.ts';
import { MemoryStore } from './modules/storage/index.ts';
import type { SubscriptionDeps } from './modules/subscription/index.ts';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const builtIn = BUILT_IN_NETWORKS[0] as NetworkConfig;

async function node(options: Partial<CalyptraOptions> = {}): Promise<Calyptra> {
  const calyptra = new Calyptra({
    store: new MemoryStore(),
    artifacts: async () => ({ wasm: '', zkey: '' }),
    createNode: async () => { throw new Error('offline'); },
    kdf: FAST_KDF,
    relayers: [],
    libp2pRelays: [],
    ...options,
  });
  await calyptra.wallet.createFromPhrase(calyptra.wallet.generatePhrase(), 'password123');
  return calyptra;
}

function relayer(fee: bigint): RelayerPort {
  const info: RelayerInfo = { chainId: builtIn.chainId, shieldedAddress: `cal${'0'.repeat(136)}`, fees: { [zeroAddress]: fee.toString() } };
  return { info: async () => info, submit: async () => ({ txHash: '0x01' }) };
}

/** The pool repository of the session that built this pool service. */
const repositoryOf = (calyptra: Calyptra): PoolDeps['repository'] =>
  (calyptra.pool as unknown as { deps: PoolDeps }).deps.repository;

describe('Calyptra', () => {
  it('builds the session services on start()', async () => {
    const calyptra = await node();
    expect(() => calyptra.pool).toThrow(/start Calyptra first/);
    expect(() => calyptra.chain).toThrow(/start Calyptra first/);
    expect(() => calyptra.channels).toThrow(/start Calyptra first/);
    await calyptra.start();
    expect(calyptra.network().id).toBe('monad-testnet');
    expect(calyptra.chain.network.id).toBe('monad-testnet');
    expect(calyptra.pool).toBeDefined();
    expect(() => calyptra.channels).toThrow(/libp2p relay/);
    expect(() => calyptra.p2p).toThrow(/libp2p relay/);
    expect(() => calyptra.disputes).toThrow(/libp2p relay/);
  });

  it('switches to a custom network and refuses an unknown one', async () => {
    const calyptra = await node({ networks: [...BUILT_IN_NETWORKS, { ...builtIn, id: 'other', chainId: 46630 }] });
    await calyptra.wallet.setNetwork('other');
    await calyptra.start();
    expect(calyptra.chain.network.chainId).toBe(46630);
    await calyptra.wallet.setNetwork('nowhere');
    await expect(calyptra.start()).rejects.toMatchObject({ code: 'UNKNOWN_NETWORK', message: 'No configuration for network "nowhere"' });
  });

  it('caps the relayer fee', async () => {
    const expensive = await node({ relayers: [relayer(500n)], maxFee: new Map([[0n, 400n]]) });
    await expensive.start();
    await expect(expensive.relayer().info()).rejects.toMatchObject({ code: 'FEE_ABOVE_MAX' });

    const fair = await node({ relayers: [relayer(300n)], maxFee: new Map([[0n, 400n]]) });
    await fair.start();
    expect((await fair.relayer().info()).fees[zeroAddress]).toBe('300');

    const none = await node();
    await none.start();
    expect(() => none.relayer()).toThrow('No transaction relayer is configured for this network');
  });

  it('applies configured relayers', async () => {
    const calyptra = await node();
    calyptra.configure({ relayers: [relayer(1n)] });
    await calyptra.start();
    expect((await calyptra.relayer().info()).fees[zeroAddress]).toBe('1');
  });

  it('fences the stores of a stopped session', async () => {
    const calyptra = await node();
    await calyptra.start();
    const first = repositoryOf(calyptra);
    await calyptra.start();
    const second = repositoryOf(calyptra);
    await expect(first.save({ syncedBlock: 41n, notes: [] })).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
    await second.save({ syncedBlock: 42n, notes: [] });
    await calyptra.lock();
    await calyptra.wallet.unlock('password123');
    await calyptra.start();
    await expect(second.save({ syncedBlock: 43n, notes: [] })).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
    expect(repositoryOf(calyptra).load().syncedBlock).toBe(42n);
  });

  it('orders the RPC endpoints: the user\'s own first, then the network\'s unless the fallback is off', async () => {
    const defaults = defaultRpcUrls(builtIn);
    expect(defaults).toEqual(['https://testnet-rpc.monad.xyz', 'https://rpc.ankr.com/monad_testnet']);
    const [default0, default1] = defaults as [string, string];
    const calyptra = await node();
    expect(calyptra.rpcUrls()).toEqual(defaults);
    calyptra.configure({ rpcUrls: ['https://mine.example', default1] });
    expect(calyptra.rpcUrls()).toEqual(['https://mine.example', default1, default0]);
    calyptra.configure({ rpcFallback: false });
    expect(calyptra.rpcUrls()).toEqual(['https://mine.example', default1]);
    calyptra.configure({ rpcUrls: [] });
    expect(calyptra.rpcUrls()).toEqual(defaults);
  });

  it('orders the event-scan endpoints: own, then the network\'s history endpoints, then its RPC endpoints', async () => {
    const history = 'https://relay.example.com/hyperrpc';
    const calyptra = await node({ networks: [{ ...builtIn, logRpcUrls: [history] }] });
    const [default0, default1] = defaultRpcUrls(builtIn) as [string, string];
    expect(calyptra.eventRpcUrls()).toEqual([history, default0, default1]);
    calyptra.configure({ rpcUrls: ['https://mine.example', default1] });
    expect(calyptra.eventRpcUrls()).toEqual(['https://mine.example', default1, history, default0]);
    expect(calyptra.rpcUrls()).toEqual(['https://mine.example', default1, default0]);   // other reads never use the history endpoint
    calyptra.configure({ rpcFallback: false });
    expect(calyptra.eventRpcUrls()).toEqual(['https://mine.example', default1]);
  });

  it('lock() stops the services and forgets the keys', async () => {
    const calyptra = await node();
    await calyptra.start();
    await calyptra.keys.poolKeys();
    await calyptra.lock();
    expect(() => calyptra.pool).toThrow(/start Calyptra first/);
    expect(() => calyptra.keys.poolKeys()).toThrow(/locked/);
  });
});

describe('Calyptra with a libp2p relay', () => {
  it('builds channels, disputes and subscriptions; only payments a subscription allowance covers skip the host', async () => {
    const relay = await createRelayNode({ listen: ['/ip4/127.0.0.1/tcp/0/ws'] });
    try {
      const asked: [string, bigint][] = [];
      const calyptra = await node({
        libp2pRelays: [String(relay.getMultiaddrs()[0])],
        createNode: createPeerNode,
        confirmPayment: async ({ channelId, amount }) => { asked.push([channelId, amount]); return false; },
        merchant: {
          offer: { kind: 'ai-chat', title: 'Echo', token: 'stablecoin', ratePerSecond: 2n, minFunding: 1n, graceSeconds: 3 },
          service: new EchoServicePort(),
        },
      });
      await calyptra.start();
      expect(calyptra.channels.list()).toEqual([]);
      expect(calyptra.disputes).toBeDefined();
      expect(calyptra.subscriptions.list()).toEqual([]);
      expect(calyptra.merchant).toBeInstanceOf(MerchantService);

      const registry = (calyptra.subscriptions as unknown as { deps: SubscriptionDeps }).deps.repository;
      await registry.save({ channelId: 'subscription', merchant: 'Echo', ratePerSecond: 2n, cap: 10n, paid: 4n });
      const confirm = (calyptra.channels as unknown as { deps: ChannelDeps }).deps.confirmPayment as NonNullable<ChannelDeps['confirmPayment']>;
      expect(await confirm({ channelId: 'subscription', token: 1n, amount: 6n })).toBe(true);    // within the allowance
      expect(await confirm({ channelId: 'subscription', token: 1n, amount: 7n })).toBe(false);   // beyond it: the host decides
      expect(await confirm({ channelId: 'tab', token: 0n, amount: 1n })).toBe(false);            // not a subscription
      expect(asked).toEqual([['subscription', 7n], ['tab', 1n]]);

      const peerId = calyptra.p2p.peerId;
      await calyptra.start();
      expect(calyptra.p2p.peerId).toBe(peerId);   // one stable libp2p identity per account
      await calyptra.lock();
      expect(() => calyptra.subscriptions).toThrow(/start Calyptra first/);
    } finally {
      await relay.stop();
    }
  });

  it('has no merchant service outside merchant mode', async () => {
    const calyptra = await node();
    await calyptra.start();
    expect(calyptra.merchant).toBeNull();
    expect(() => calyptra.subscriptions).toThrow(/libp2p relay/);
  });
});

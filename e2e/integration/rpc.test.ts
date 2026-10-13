// RPC endpoints: failover, range-limited and lagging endpoints, chain checks, and a
// transaction never re-sent elsewhere (INT-R1..R6), through local JSON-RPC proxies in front of the dev
// chain. Then wallet sync through the network's history endpoints (`logRpcUrls`): the desktop
// client's real POST /hyperrpc route, served in-process from its event cache (filled from the dev chain
// standing in for Envio HyperRPC), and the order endpoints are tried in (user endpoints, then
// logRpcUrls, then the network's RPC endpoints; only the user's when the fallback is off).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseEther } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRelayerApp } from '../../apps/desktop/src/app.ts';
import { createHyperRpcService, type HyperRpcService } from '../../apps/desktop/src/modules/hyperrpc/index.ts';
import { createLogger } from '../../apps/desktop/src/shared/logger.ts';
import type { Calyptra } from '../../packages/framework/src/calyptra.ts';
import { ChainAdapter, type ChainAdapterOptions, type NetworkConfig } from '../../packages/framework/src/modules/chain/index.ts';
import type { Deployment } from '../../scripts/lib/deploy.ts';
import { freshDeployment, mineBlocks } from './chain.ts';
import { closeProxies, proxy, type RpcProxy } from './rpc-proxy.ts';
import { devNetwork, newCalyptra, newPhrase, newRelayer, newUser, until } from './services.ts';

const NATIVE = 0n;
const CENT = parseEther('0.01');
/** The RPC tests' adapter options. */
const OPTIONS: ChainAdapterOptions = { logWindow: 64n, minLogWindow: 2n, retryAfterMs: 500 };

let d: Deployment;
let network: NetworkConfig;
let direct: ChainAdapter;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function history(chain: ChainAdapter): Promise<{ commitments: bigint[]; nullifiers: bigint[] }> {
  const { commitments, nullifiers } = await chain.poolEvents(BigInt(d.deployBlock));
  return { commitments: commitments.map((c) => c.commitment), nullifiers };
}
const adapter = (...proxies: RpcProxy[]): ChainAdapter => new ChainAdapter(network, { rpcUrls: proxies.map((p) => p.url), ...OPTIONS });
const shielded = (pool: { balances(): Map<bigint, bigint> }): bigint => pool.balances().get(NATIVE) ?? 0n;

beforeAll(async () => {
  d = await freshDeployment();
  network = devNetwork(d);
  direct = new ChainAdapter(network);
  const user = await newUser(network, direct);
  for (let i = 0; i < 3; i++) await user.pool.deposit(NATIVE, CENT);
  await mineBlocks(20); // the history spans more blocks than a range-limited endpoint serves at once
});

afterAll(closeProxies);

describe('RPC endpoints', () => {
  it('INT-R1: reads the full history through a range-limited endpoint by shrinking the window', async () => {
    const limited = await proxy({ maxRange: 8 });
    const expected = await history(direct);
    expect(expected.commitments).toHaveLength(3);
    expect(await history(adapter(limited))).toEqual(expected);
    expect(limited.methods.filter((m) => m === 'eth_getLogs').length).toBeGreaterThan(2);
  });

  it('INT-R2: uses the next endpoint while one is down, and the preferred one again once it answers', async () => {
    const [first, second] = [await proxy({ mode: 'down' }), await proxy()];
    const chain = adapter(first, second);
    expect(await chain.latestBlock()).toBeGreaterThan(0n);
    expect(second.methods).toContain('eth_blockNumber');
    first.clear();
    second.clear();
    await chain.latestBlock();
    expect(first.methods).toEqual([]); // passed over
    expect(second.methods).toContain('eth_blockNumber');
    first.mode = 'forward';
    first.clear();
    second.clear();
    await sleep(600);
    await chain.latestBlock();
    expect(first.methods).toContain('eth_blockNumber');
    expect(second.methods).toEqual([]);
  });

  it('INT-R3: never trusts an endpoint of another chain', async () => {
    const [wrong, right] = [await proxy({ mode: 'wrong-chain' }), await proxy()];
    const chain = adapter(wrong, right);
    const expected = await history(direct);
    expect(await history(chain)).toEqual(expected);
    expect(wrong.methods).toEqual(['eth_chainId']);
    await history(chain);
    expect(wrong.methods).toEqual(['eth_chainId']);
  });

  it('INT-R4: one sync uses one endpoint end to end; a lagging endpoint never makes the wallet skip a note', async () => {
    const [ahead, behind] = [await proxy(), await proxy()];
    const user = await newUser(network, adapter(ahead, behind));
    await user.pool.deposit(NATIVE, CENT);
    expect(shielded(user.pool)).toBe(CENT);
    behind.lag = 50;
    ahead.mode = 'fail-logs';
    await user.pool.deposit(NATIVE, CENT).catch(() => undefined); // its closing sync may fail: ignored
    await user.pool.sync();
    expect(shielded(user.pool)).toBe(CENT); // no mixing of one endpoint's head with the other's events
    behind.lag = 0;
    await user.pool.sync();
    expect(shielded(user.pool)).toBe(2n * CENT);
  });

  it('INT-R5: fails plainly when no endpoint answers', async () => {
    const chain = adapter(await proxy({ mode: 'down' }));
    await expect(chain.latestBlock()).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE', message: `No RPC endpoint of ${network.name} is answering` });
  });

  it('INT-R6: never re-sends a transaction through another endpoint', async () => {
    const [flaky, other] = [await proxy({ mode: 'drop-receipts' }), await proxy()];
    const user = await newUser(network, adapter(flaky, other));
    const before = (await history(direct)).commitments.length;
    await expect(user.pool.deposit(NATIVE, CENT)).rejects.toThrow();
    expect(other.methods).not.toContain('eth_sendRawTransaction');
    await until(async () => (await history(direct)).commitments.length > before, 30_000, 'the deposit to land');
    expect((await history(direct)).commitments).toHaveLength(before + 1);
  });
});

describe('wallet sync through the network’s history endpoints', () => {
  /** The network's own RPC endpoint and the user's own endpoint (recording proxies of the dev chain). */
  let networkRpc: RpcProxy;
  let userRpc: RpcProxy;
  /** What the route's event cache asks upstream (the dev chain standing in for Envio HyperRPC). */
  let upstream: RpcProxy;
  /** Requests that reached the /hyperrpc route at all. */
  let routeHits = 0;
  /** While set, the route answers 503 as a whole, so wallets fail over. */
  let routeDown = false;
  let route: Server;
  let hyperRpc: HyperRpcService;
  let logNetwork: NetworkConfig;
  let phrase: string;
  const deposits = 2n * CENT;

  /** A new device: the wallet restored from the phrase, synced once from nothing. */
  const newDevice = (options: { rpcUrls?: string[]; rpcFallback?: boolean } = {}): Promise<Calyptra> =>
    newCalyptra(logNetwork, { phrase, ...options });
  const getLogs = (p: RpcProxy): number => p.methods.filter((m) => m === 'eth_getLogs').length;
  const reset = (): void => {
    for (const p of [networkRpc, userRpc, upstream]) {
      p.clear();
      p.mode = 'forward';
    }
    routeHits = 0;
    routeDown = false;
  };
  /** The last block the route's cache covers (null while it warms up). */
  const cachedTo = (): bigint | null => {
    const answer = hyperRpc.answer({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' });
    return 'result' in answer ? BigInt(answer.result as string) : null;
  };

  beforeAll(async () => {
    [networkRpc, userRpc, upstream] = [await proxy(), await proxy(), await proxy()];
    const relayer = await newRelayer(network, direct, { native: 10n ** 14n, stable: 10_000n });
    // The relay host reads the head on the network's own endpoint (the dev chain), not through networkRpc.
    hyperRpc = createHyperRpcService({ network, upstreamUrl: upstream.url, logger: createLogger('silent'), upstreamSpacingMs: 0, pollIntervalMs: 100 });
    hyperRpc.start();
    const app = createRelayerApp({ relayer: relayer.service, logger: createLogger('silent'), hyperRpc });
    route = createServer((req, res) => {
      routeHits++;
      if (routeDown) res.writeHead(503).end('down');
      else app(req, res);
    });
    await new Promise<void>((resolve) => route.listen(0, '127.0.0.1', resolve));
    const hyperRpcUrl = `http://127.0.0.1:${(route.address() as AddressInfo).port}/hyperrpc`;
    logNetwork = { ...network, id: 'devnode-logs', rpcUrl: networkRpc.url, logRpcUrls: [hyperRpcUrl] };
    phrase = newPhrase();
    const first = await newCalyptra(logNetwork, { phrase, native: '1' });
    await first.pool.deposit(NATIVE, CENT);
    await first.pool.deposit(NATIVE, CENT);
    await first.stop();
    await mineBlocks(250); // the history now spans several 100-block RPC windows
    const head = await direct.latestBlock();
    await until(() => (cachedTo() ?? 0n) >= head - 3n, 30_000, 'the event cache to reach the head');
  });

  afterAll(async () => {
    await hyperRpc?.stop();
    await new Promise<void>((resolve) => route?.close(() => resolve()));
  });

  it('scans the whole history through the history endpoint first, answered from its cache; nothing else goes there', async () => {
    reset();
    const device = await newDevice();
    expect(device.eventRpcUrls()).toEqual([...(logNetwork.logRpcUrls ?? []), networkRpc.url]);
    await device.pool.sync();
    expect(shielded(device.pool)).toBe(deposits);
    expect(routeHits).toBeGreaterThan(0);
    expect(networkRpc.methods).toEqual([]);
    // The cache asks upstream for nothing but eth_getLogs, and only as the chain moves on, never per wallet.
    expect(upstream.methods.every((m) => m === 'eth_getLogs')).toBe(true);
    await device.stop();
  });

  it('falls back to the network’s RPC endpoints, in windows of at most 100 blocks', async () => {
    reset();
    routeDown = true;
    const device = await newDevice();
    await device.pool.sync();
    expect(shielded(device.pool)).toBe(deposits);
    expect(getLogs(networkRpc)).toBeGreaterThanOrEqual(6); // > 250 blocks in 100-block windows, two event types
    expect(networkRpc.ranges.every(([from, to]) => to - from + 1 <= 100)).toBe(true);
    await device.stop();
  });

  it('tries the user’s own endpoints first, then the history endpoint, then the network’s RPC endpoints', async () => {
    reset();
    const own = await newDevice({ rpcUrls: [userRpc.url] });
    expect(own.eventRpcUrls()).toEqual([userRpc.url, ...(logNetwork.logRpcUrls ?? []), networkRpc.url]);
    await own.pool.sync();
    expect(shielded(own.pool)).toBe(deposits);
    expect(getLogs(userRpc)).toBeGreaterThanOrEqual(6); // the user's endpoint is an RPC endpoint: 100-block windows
    expect([routeHits, networkRpc.methods.length]).toEqual([0, 0]);
    await own.stop();

    reset();
    userRpc.mode = 'down';
    const ownDown = await newDevice({ rpcUrls: [userRpc.url] });
    await ownDown.pool.sync();
    expect(shielded(ownDown.pool)).toBe(deposits);
    expect(userRpc.methods.length).toBeGreaterThan(0);
    expect(routeHits).toBeGreaterThan(0);
    expect(networkRpc.methods).toEqual([]);
    await ownDown.stop();

    reset();
    userRpc.mode = 'down';
    routeDown = true;
    const bothDown = await newDevice({ rpcUrls: [userRpc.url] });
    await bothDown.pool.sync();
    expect(shielded(bothDown.pool)).toBe(deposits);
    expect(getLogs(networkRpc)).toBeGreaterThanOrEqual(6);
    await bothDown.stop();
  });

  it('with the fallback off, contacts only the user’s endpoints, and says so when none answers', async () => {
    reset();
    userRpc.mode = 'down';
    const device = await newDevice({ rpcUrls: [userRpc.url], rpcFallback: false });
    expect(device.eventRpcUrls()).toEqual([userRpc.url]);
    expect(device.rpcUrls()).toEqual([userRpc.url]);
    await expect(device.pool.sync()).rejects.toMatchObject({
      code: 'RPC_UNAVAILABLE', message: `No RPC endpoint of ${logNetwork.name} is answering`,
    });
    expect(userRpc.methods.length).toBeGreaterThan(0);
    expect([routeHits, networkRpc.methods.length]).toEqual([0, 0]);
    await device.stop();
  });
});

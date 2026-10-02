import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encodeAbiParameters, encodeEventTopics, keccak256, numberToHex, toHex, zeroAddress, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { poolAbi } from './chain.abi.ts';
import {
  BUILT_IN_NETWORKS, ChainAdapter, DEPOSIT_GAS_LIMIT, MONAD_RESERVE_BALANCE, NetworkConfigSchema, reserveBalanceOf, tokenAddress, type NetworkConfig,
} from './index.ts';

const POOL = '0x00000000000000000000000000000000000000aa';
const DISPUTES = '0x00000000000000000000000000000000000000bb';
const CHAIN_ID = 10143;
const GWEI = 10n ** 9n;

interface Rpc {
  url: string;
  /** Every request, and the [from, to] range of every eth_getLogs. */
  methods: string[];
  ranges: [number, number][];
  /** With `send`: the head block when each raw transaction arrived (the mock includes it in that block). */
  sentAt: number[];
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/**
 * A JSON-RPC endpoint at block `head` (read on every request, so a test can move it on) that refuses log
 * ranges over `maxRange` blocks and answers one commitment at block 5. With `send` it also takes
 * transactions: calls succeed, allowances are 0, and each transaction is included at once in the head block.
 */
async function rpc(options: { head: number; maxRange?: number; chainId?: number; down?: boolean; balance?: bigint; send?: boolean }): Promise<Rpc> {
  const methods: string[] = [];
  const ranges: [number, number][] = [];
  const sentAt: number[] = [];
  const included = new Map<string, number>();
  const commitmentLog = (leafIndex: bigint, blockNumber: number): Record<string, unknown> => ({
    address: POOL,
    topics: encodeEventTopics({ abi: poolAbi, eventName: 'NewCommitment', args: { commitment: 1000n + leafIndex } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [leafIndex, '0x1234']),
    blockNumber: numberToHex(blockNumber), blockHash: toHex(1n, { size: 32 }), transactionHash: toHex(2n, { size: 32 }),
    transactionIndex: '0x0', logIndex: numberToHex(Number(leafIndex)), removed: false,
  });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      if (options.down) { res.writeHead(503).end('down'); return; }
      const request = JSON.parse(body) as { id: number; method: string; params: [{ fromBlock: Hex; toBlock: Hex; topics: Hex[] }] };
      methods.push(request.method);
      const reply = (result: unknown): void => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })); };
      if (request.method === 'eth_chainId') return reply(numberToHex(options.chainId ?? CHAIN_ID));
      if (request.method === 'eth_blockNumber') return reply(numberToHex(options.head));
      if (request.method === 'eth_getBalance') return reply(numberToHex(options.balance ?? 0n));
      if (request.method === 'eth_maxPriorityFeePerGas') return reply(numberToHex(GWEI * 2n));
      if (options.send) {
        const param = (): Hex => (request.params as unknown as [Hex])[0];
        if (request.method === 'eth_call') return reply(body.includes('dd62ed3e') ? numberToHex(0n, { size: 32 }) : '0x'); // allowance(): 0
        if (request.method === 'eth_getTransactionCount') return reply(numberToHex(sentAt.length));
        if (request.method === 'eth_sendRawTransaction') {
          const hash = keccak256(param());
          sentAt.push(options.head);
          included.set(hash, options.head);
          return reply(hash);
        }
        if (request.method === 'eth_getTransactionReceipt') {
          return reply({
            transactionHash: param(), transactionIndex: '0x0', blockHash: toHex(5n, { size: 32 }), blockNumber: numberToHex(included.get(param()) ?? 0),
            from: zeroAddress, to: POOL, cumulativeGasUsed: '0x0', gasUsed: '0x0', effectiveGasPrice: '0x0', contractAddress: null,
            logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x2',
          });
        }
      }
      if (request.method === 'eth_getBlockByNumber') {
        return reply({
          number: numberToHex(options.head), hash: toHex(3n, { size: 32 }), parentHash: toHex(4n, { size: 32 }), timestamp: '0x1',
          baseFeePerGas: numberToHex(GWEI * 100n), gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [],
        });
      }
      if (request.method === 'eth_getLogs') {
        const { fromBlock, toBlock, topics } = request.params[0];
        const from = Number(fromBlock);
        const to = Number(toBlock);
        if (options.maxRange !== undefined && to - from + 1 > options.maxRange) {
          res.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32005, message: `query exceeds max block range ${options.maxRange}` } }));
          return;
        }
        ranges.push([from, to]);
        const commitmentTopic = encodeEventTopics({ abi: poolAbi, eventName: 'NewCommitment' })[0];
        const logs = topics[0] === commitmentTopic
          ? [commitmentLog(1n, 7), commitmentLog(0n, 5)].filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to)
          : [];
        return reply(logs);
      }
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, methods, ranges, sentAt };
}

function network(rpcUrl: string, extra: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    id: 'test', name: 'Test chain', chainId: CHAIN_ID, rpcUrl, stablecoin: '0x00000000000000000000000000000000000000cc',
    contracts: { pool: POOL, disputes: DISPUTES, deployBlock: 1n }, relayers: [], libp2pRelays: [], ...extra,
  };
}

describe('ChainAdapter event scans (§11.3)', () => {
  it('scans the RPC endpoints in 100-block windows and decodes commitments in leaf order', async () => {
    const node = await rpc({ head: 250, maxRange: 100 });
    const events = await new ChainAdapter(network(node.url)).poolEvents(1n);
    expect(events.toBlock).toBe(250n);
    expect(events.commitments.map((c) => [c.commitment, c.leafIndex, c.blockNumber])).toEqual([[1000n, 0, 5n], [1001n, 1, 7n]]);
    expect(events.commitments[0]?.ciphertext).toBe('0x1234');
    expect(events.nullifiers).toEqual([]);
    expect(node.ranges).toHaveLength(6);   // 3 windows x 2 events
    expect(new Set(node.ranges.map(([from, to]) => `${from}-${to}`))).toEqual(new Set(['1-100', '101-200', '201-250']));
  });

  it('does not go below 100 blocks on the RPC endpoints', async () => {
    const node = await rpc({ head: 250, maxRange: 50 });
    // The refusal at 100 blocks is the endpoint failing: the read fails over, and here no endpoint is left.
    await expect(new ChainAdapter(network(node.url)).poolEvents(1n)).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });
    expect(node.ranges).toEqual([]);
  });

  it('tries the history endpoints first, with large windows halving on refusal; other reads stay on the RPC endpoints', async () => {
    const history = await rpc({ head: 300_000, maxRange: 30_000 });
    const node = await rpc({ head: 300_000 });
    const chain = new ChainAdapter(network(node.url, { logRpcUrls: [history.url] }));
    const events = await chain.poolEvents(1n);
    expect(events.commitments).toHaveLength(2);
    expect(node.methods).not.toContain('eth_getLogs');
    // 100,000 -> 50,000 -> 25,000 accepted
    expect(Math.max(...history.ranges.map(([from, to]) => to - from + 1))).toBe(25_000);
    expect(await chain.latestBlock()).toBe(300_000n);
    expect(history.methods.filter((m) => m === 'eth_blockNumber')).toHaveLength(1);   // only the scan's own head
  });

  it('falls back to the RPC endpoints when the history endpoint is down', async () => {
    const history = await rpc({ head: 150, down: true });
    const node = await rpc({ head: 150, maxRange: 100 });
    const chain = new ChainAdapter(network(node.url, { logRpcUrls: [history.url] }));
    expect((await chain.poolEvents(1n)).commitments).toHaveLength(2);
    expect(node.ranges.every(([from, to]) => to - from + 1 <= 100)).toBe(true);
  });

  it('scans the user\'s endpoints first, then the history endpoints, then the network\'s RPC endpoints', async () => {
    const head = 250;
    const logs = (r: Rpc): number => r.methods.filter((m) => m === 'eth_getLogs').length;
    const scan = async (ownDown: boolean, historyDown: boolean): Promise<[Rpc, Rpc, Rpc]> => {
      const own = await rpc({ head, down: ownDown });
      const history = await rpc({ head, down: historyDown });
      const node = await rpc({ head });
      const chain = new ChainAdapter(network(node.url, { logRpcUrls: [history.url] }), {
        rpcUrls: [own.url, node.url], eventRpcUrls: [own.url, history.url, node.url],
      });
      expect((await chain.poolEvents(1n)).commitments).toHaveLength(2);
      return [own, history, node];
    };
    const [own1, history1, node1] = await scan(false, false);
    expect(logs(own1)).toBe(6);                                            // 100-block windows: 3 x 2 events
    expect([logs(history1), logs(node1)]).toEqual([0, 0]);
    const [, history2, node2] = await scan(true, false);
    expect(logs(history2)).toBe(2);                                        // one large window per event
    expect(logs(node2)).toBe(0);
    const [, , node3] = await scan(true, true);
    expect(logs(node3)).toBe(6);
  });

  it('never contacts the history endpoints when they are not listed (network fallback off)', async () => {
    const own = await rpc({ head: 50 });
    const history = await rpc({ head: 50 });
    const node = await rpc({ head: 50 });
    const chain = new ChainAdapter(network(node.url, { logRpcUrls: [history.url] }), { rpcUrls: [own.url], eventRpcUrls: [own.url] });
    expect((await chain.poolEvents(1n)).commitments).toHaveLength(2);
    expect(await chain.latestBlock()).toBe(50n);
    expect(history.methods).toEqual([]);
    expect(node.methods).toEqual([]);
  });

  it('never uses an endpoint of another chain', async () => {
    const wrong = await rpc({ head: 10, chainId: 1 });
    const right = await rpc({ head: 10 });
    const chain = new ChainAdapter(network(right.url), { rpcUrls: [wrong.url, right.url] });
    expect(await chain.latestBlock()).toBe(10n);
    expect(await chain.latestBlock()).toBe(10n);
    expect(wrong.methods).toEqual(['eth_chainId']);
  });

  it('reports a network without contracts and an unreachable network', async () => {
    const node = await rpc({ head: 10, down: true });
    const undeployed = new ChainAdapter(network(node.url, { contracts: undefined }));
    expect(() => undeployed.contracts()).toThrow('Calyptra is not deployed on Test chain yet');
    await expect(undeployed.latestBlock()).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE', message: 'No RPC endpoint of Test chain is answering' });
  });
});

describe('ChainAdapter.deposit and the Monad reserve', () => {
  const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const ciphertext = `0x${'00'.repeat(168)}` as const;
  // Fees of the mock: base fee 100 gwei (x 1.2 headroom) + 2 gwei tip = 122 gwei; x 1.3M gas = 0.1586 MON.
  const budget = DEPOSIT_GAS_LIMIT * 122n * GWEI;
  const amount = 10n ** 16n;   // 0.01 MON
  const polls = (node: Rpc): number => node.methods.filter((m) => m === 'eth_blockNumber').length;

  it('refuses a native deposit the balance cannot cover with its network fee, on every chain, before sending anything', async () => {
    for (const chainId of [CHAIN_ID, 31337]) {
      const node = await rpc({ head: 10, chainId, balance: amount + budget - 1n, send: true });
      await expect(new ChainAdapter(network(node.url, { chainId })).deposit(account, 0n, amount, 1n, ciphertext)).rejects.toMatchObject({
        statusCode: 409, code: 'INSUFFICIENT_PUBLIC_FUNDS', message: 'This account does not have enough MON for this amount plus the network fee',
      });
      expect(node.methods).not.toContain('eth_call');
      expect(node.methods).not.toContain('eth_sendRawTransaction');
    }
  });

  it('lets a native deposit go below the 10 MON reserve on Monad when the balance covers it and its network fee', async () => {
    const node = await rpc({ head: 10, balance: amount + budget, send: true });
    await new ChainAdapter(network(node.url)).deposit(account, 0n, amount, 1n, ciphertext);
    expect(node.sentAt).toEqual([10]);   // the account sent nothing before: no wait
  });

  it('waits until 3 blocks after the account’s last approve or deposit before going below the reserve', async () => {
    for (const first of [0n, 1n]) {     // after a native deposit; after a stablecoin approve and deposit
      const chain = { head: 10, balance: amount + budget, send: true };
      const node = await rpc(chain);
      const adapter = new ChainAdapter(network(node.url));
      await adapter.deposit(account, first, amount, 1n, ciphertext);
      const earlier = [...node.sentAt];
      expect(earlier).toEqual(first === 0n ? [10] : [10, 10]);
      const before = polls(node);
      const next = adapter.deposit(account, 0n, amount, 1n, ciphertext);
      await vi.waitFor(() => expect(polls(node)).toBeGreaterThan(before), { timeout: 5_000 });
      chain.head = 12;
      const seen = polls(node);
      await vi.waitFor(() => expect(polls(node)).toBeGreaterThan(seen + 1), { timeout: 5_000 });
      expect(node.sentAt).toEqual(earlier);   // block 12 is still within 3 blocks of block 10
      chain.head = 13;
      await next;
      expect(node.sentAt).toEqual([...earlier, 13]);
    }
  }, 20_000);

  it('does not wait when the reserve stays, nor outside Monad', async () => {
    for (const [chainId, balance] of [[CHAIN_ID, MONAD_RESERVE_BALANCE + amount + budget], [31337, amount + budget]] as const) {
      const node = await rpc({ head: 10, chainId, balance, send: true });
      const adapter = new ChainAdapter(network(node.url, { chainId }));
      await adapter.deposit(account, 0n, amount, 1n, ciphertext);
      await adapter.deposit(account, 0n, amount, 1n, ciphertext);
      expect(node.sentAt).toEqual([10, 10]);
    }
  });

  it('gives up after about 10 s when the network does not move on', async () => {
    const node = await rpc({ head: 10, balance: amount + budget, send: true });
    const adapter = new ChainAdapter(network(node.url));
    await adapter.deposit(account, 0n, amount, 1n, ciphertext);
    vi.useFakeTimers({ toFake: ['Date'] });   // only the clock: requests and polling stay real
    try {
      const next = adapter.deposit(account, 0n, amount, 1n, ciphertext).catch((e: unknown) => e);
      await vi.waitFor(() => expect(polls(node)).toBeGreaterThan(0), { timeout: 5_000 });
      vi.setSystemTime(Date.now() + 10_000);
      expect(await next).toMatchObject({
        statusCode: 503, code: 'CHAIN_STALLED', message: 'The network has not moved on since this account’s last transaction; try again in a moment',
      });
      expect(node.sentAt).toEqual([10]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('has a reserve only on Monad, and checks no balance for stablecoin deposits', async () => {
    expect(reserveBalanceOf(10143)).toBe(MONAD_RESERVE_BALANCE);
    expect(reserveBalanceOf(143)).toBe(MONAD_RESERVE_BALANCE);
    expect(reserveBalanceOf(31337)).toBe(0n);
    const stable = await rpc({ head: 10, balance: 0n, send: true });
    await new ChainAdapter(network(stable.url)).deposit(account, 1n, amount, 1n, ciphertext);
    expect(stable.methods).not.toContain('eth_getBalance');
    expect(stable.sentAt).toEqual([10, 10]);   // approve, deposit
  });
});

describe('chain config', () => {
  it('ships Monad testnet as the one built-in network, valid against the schema', () => {
    expect(BUILT_IN_NETWORKS).toHaveLength(1);
    const [monad] = BUILT_IN_NETWORKS;
    expect(monad).toMatchObject({ id: 'monad-testnet', name: 'Monad Testnet', chainId: 10143, rpcUrl: 'https://testnet-rpc.monad.xyz' });
    expect(NetworkConfigSchema.parse(monad)).toEqual(monad);
    expect(monad?.contracts).toBeUndefined();   // filled in at deployment
  });

  it('parses a string deployBlock and the optional history endpoints', () => {
    const parsed = NetworkConfigSchema.parse({ ...network('http://127.0.0.1:1'), contracts: { pool: POOL, disputes: DISPUTES, deployBlock: '123' }, logRpcUrls: ['https://relay.example.com/hyperrpc'] });
    expect(parsed.contracts?.deployBlock).toBe(123n);
    expect(parsed.logRpcUrls).toEqual(['https://relay.example.com/hyperrpc']);
  });

  it('maps token ids to lowercase addresses', () => {
    expect(tokenAddress(0n)).toBe(zeroAddress);
    expect(tokenAddress(BigInt('0xA9012a055bd4e0edff8ce09f960291c09d5322dc'))).toBe('0xa9012a055bd4e0edff8ce09f960291c09d5322dc');
  });
});

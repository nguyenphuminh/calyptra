import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { NetworkConfig, RelayerService } from '@calyptra/framework';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRelayerApp } from '../../app.ts';
import { createHyperRpcService, envioHyperRpcUrl } from './index.ts';
import type { HyperRpcService } from './index.ts';
import { FINALITY_BLOCKS, LOG_WINDOW, POLL_INTERVAL_MS, UPSTREAM_SPACING_MS } from './log-cache.service.ts';

// The tests run in order and share one event cache over a mock chain: a stand-in for Envio HyperRPC
// (the upstream) and the network's public RPC endpoints (the first one down, the backup answering).

const POOL = '0x1111111111111111111111111111111111111111';
const DISPUTES = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const DEPLOY_BLOCK = 1_000;
/** The upstream refuses eth_getLogs over more blocks than this, so the 100,000-block window halves once. */
const MAX_RANGE = 60_000;
const SPACING_MS = 40;
const POLL_MS = 30;

const hex = (n: number): string => `0x${n.toString(16)}`;
const topic = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const [COMMITMENT, NULLIFIER, DISPUTE, FINALIZED] = [topic(0xc0), topic(0xa1), topic(0xd1), topic(0xf1)];

interface ChainLog { address: string; topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash: string; removed: boolean }
const chainLog = (address: string, block: number, index: number, topics: string[]): ChainLog => ({
  address, topics, data: `0x${block.toString(16).padStart(8, '0')}`, blockNumber: hex(block), logIndex: hex(index), transactionHash: topic(block * 10 + index), removed: false,
});

/** The mock chain: its head and every log of the two contracts (and one of another contract). */
let head = 350_003;
const chainLogs: ChainLog[] = [
  chainLog(POOL, 1_000, 0, [COMMITMENT, topic(1)]),
  chainLog(POOL, 1_000, 1, [NULLIFIER, topic(2)]),
  chainLog(OTHER, 2_000, 0, [COMMITMENT, topic(1)]),
  chainLog(DISPUTES, 60_000, 0, [DISPUTE, topic(3), topic(4)]),
  chainLog(POOL, 150_999, 3, [COMMITMENT, topic(5)]),
  chainLog(POOL, 151_000, 0, [NULLIFIER, topic(6)]),
  chainLog(POOL, 349_999, 2, [COMMITMENT, topic(7)]),
  chainLog(POOL, 349_999, 0, [COMMITMENT, topic(8)]),
  chainLog(DISPUTES, 350_000, 0, [FINALIZED, topic(3)]),
  chainLog(POOL, 350_001, 0, [COMMITMENT, topic(9)]), // inside the finality margin at first
];
const ordered = (logs: ChainLog[]): ChainLog[] =>
  [...logs].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
const logsOf = (addresses: string[], from: number, to: number): ChainLog[] =>
  ordered(chainLogs.filter((l) => addresses.includes(l.address) && Number(l.blockNumber) >= from && Number(l.blockNumber) <= to));

interface Received { at: number; method: string; params: unknown[] }
/** Every request that reached the upstream, with its arrival time. */
const upstreamReceived: Received[] = [];
let upstreamStatus = 200;
/** Every method asked of the network's public RPC endpoints. */
const publicReceived: { endpoint: 'main' | 'backup'; method: string }[] = [];
/** Everything the relayer app and the cache log. */
const logLines: string[] = [];
const servers: Server[] = [];
let hyperRpc: HyperRpcService;
let proxyUrl: string;

const body = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk: Buffer) => (text += chunk.toString()));
    req.on('end', () => resolve(text));
  });

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Envio HyperRPC: eth_getLogs over an address array, refusing ranges over MAX_RANGE, answering in no particular order. */
const upstream = createServer((req, res) => {
  void body(req).then((text) => {
    const { id, method, params } = JSON.parse(text) as { id: number; method: string; params: unknown[] };
    upstreamReceived.push({ at: performance.now(), method, params });
    const reply = (payload: object): void => void res.writeHead(upstreamStatus, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }));
    if (upstreamStatus !== 200) return reply({ error: { code: -32000, message: 'busy' } });
    if (method !== 'eth_getLogs') return reply({ error: { code: -32601, message: 'unexpected method' } });
    const filter = params[0] as { address: string[]; fromBlock: string; toBlock: string };
    const [from, to] = [Number(filter.fromBlock), Number(filter.toBlock)];
    if (to - from + 1 > MAX_RANGE) return reply({ error: { code: -32602, message: `block range too large, max ${MAX_RANGE} blocks` } });
    return reply({ result: logsOf(filter.address.map((a) => a.toLowerCase()), from, to).reverse() });
  });
});
const publicRpc = (endpoint: 'main' | 'backup') =>
  createServer((req, res) => {
    void body(req).then((text) => {
      const { id, method } = JSON.parse(text) as { id: number; method: string };
      publicReceived.push({ endpoint, method });
      if (endpoint === 'main') return void res.writeHead(503).end('down');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result: hex(head) }));
    });
  });

beforeAll(async () => {
  expect(process.env.CALYPTRA_ENVIO_TOKEN).toBeUndefined(); // tests never use the real token
  const upstreamUrl = `${await listen(upstream)}/mock-token-path`;
  const network: NetworkConfig = {
    id: 'test', name: 'Test chain', chainId: 10143, rpcUrl: await listen(publicRpc('main')), backupRpcUrls: [await listen(publicRpc('backup'))],
    stablecoin: '0x4444444444444444444444444444444444444444', contracts: { pool: POOL, disputes: DISPUTES, deployBlock: BigInt(DEPLOY_BLOCK) },
    relayers: [], libp2pRelays: [],
  };
  const logger = pino({ level: 'info' }, { write: (line: string) => void logLines.push(line) });
  hyperRpc = createHyperRpcService({ network, upstreamUrl, logger, upstreamSpacingMs: SPACING_MS, pollIntervalMs: POLL_MS });
  const relayer = {} as RelayerService; // never reached by these requests
  proxyUrl = await listen(createServer(createRelayerApp({ relayer, logger, hyperRpc })));
});
afterAll(async () => {
  await hyperRpc.stop();
  for (const server of servers) server.close();
});

const rpc = (payload: unknown): Promise<Response> =>
  fetch(`${proxyUrl}/hyperrpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const call = async (method: string, params?: unknown[]): Promise<{ result?: unknown; error?: { code: number; message: string } }> =>
  (await rpc({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) })).json() as Promise<{ result?: unknown; error?: { code: number; message: string } }>;
const getLogs = async (filter: object): Promise<unknown> => (await call('eth_getLogs', [filter])).result;
const blockNumber = async (): Promise<unknown> => (await call('eth_blockNumber', [])).result;

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const ranges = (received: Received[]): [number, number][] =>
  received.map((r) => {
    const filter = r.params[0] as { fromBlock: string; toBlock: string };
    return [Number(filter.fromBlock), Number(filter.toBlock)];
  });
const messages = (): string[] => logLines.map((l) => (JSON.parse(l) as { msg: string }).msg);

/** Every request the allow-list refuses, unchanged by the cache. */
const REFUSED = [
  { jsonrpc: '2.0', id: 5, method: 'eth_sendRawTransaction', params: ['0x00'] },
  { jsonrpc: '2.0', id: 6, method: 'eth_call', params: [{ to: POOL, data: '0x' }, 'latest'] },
  { jsonrpc: '2.0', id: 7, method: 'eth_getLogs', params: [{ address: OTHER, fromBlock: '0x1', toBlock: '0x2' }] },
  { jsonrpc: '2.0', id: 8, method: 'eth_getLogs', params: [{ address: [POOL, OTHER] }] },
  { jsonrpc: '2.0', id: 9, method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x2', topics: [] }] },
  { jsonrpc: '2.0', id: 10, method: 'eth_getLogs', params: [] },
];
async function expectRefusals(): Promise<void> {
  for (const request of REFUSED) {
    const res = await rpc(request);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: request.id, error: { code: -32601 } });
  }
}

/** Calls are spaced from their send times; their arrival times here jitter under load, so the check is on
 *  the whole run (n calls take at least n - 1 spacings) rather than on each gap. */
function expectSpaced(at: readonly number[]): void {
  expect((at.at(-1) ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual((at.length - 1) * SPACING_MS - 10);
}

describe('POST /hyperrpc, answered from the event cache', () => {
  it('answers every method with -32000 "warming up" until the backfill completes; refusals stay -32601', async () => {
    upstreamStatus = 429; // the upstream refuses: the backfill cannot complete
    hyperRpc.start();
    await until(() => upstreamReceived.length >= 2, 'two upstream attempts');
    for (const [method, params] of [['eth_chainId', []], ['eth_blockNumber', []], ['eth_getLogs', [{ address: POOL, fromBlock: '0x0' }]]] as const) {
      expect(await (await rpc({ jsonrpc: '2.0', id: 3, method, params })).json()).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'warming up' } });
    }
    await expectRefusals();
    expect(messages()).toContain('event cache update failed; retrying later'); // and the node runs on
  });

  it('backfills both contracts from the deploy block in 100,000-block windows, one upstream eth_getLogs each, halving on a range refusal', async () => {
    upstreamReceived.length = 0;
    upstreamStatus = 200;
    await until(async () => (await blockNumber()) !== undefined, 'the backfill');
    const cachedTo = head - Number(FINALITY_BLOCKS);
    expect(await blockNumber()).toBe(hex(cachedTo));
    // Only eth_getLogs ever reaches the upstream: for both contracts at once, without topics.
    expect(upstreamReceived.every((r) => r.method === 'eth_getLogs')).toBe(true);
    for (const r of upstreamReceived) expect(Object.keys(r.params[0] as object).sort()).toEqual(['address', 'fromBlock', 'toBlock']);
    expect(upstreamReceived.every((r) => JSON.stringify((r.params[0] as { address: unknown }).address) === JSON.stringify([POOL, DISPUTES]))).toBe(true);
    const half = Number(LOG_WINDOW) / 2;
    const windows: [number, number][] = [];
    for (let from = DEPLOY_BLOCK; from <= cachedTo; from += half) windows.push([from, Math.min(from + half - 1, cachedTo)]);
    expect(ranges(upstreamReceived)).toEqual([[DEPLOY_BLOCK, DEPLOY_BLOCK + Number(LOG_WINDOW) - 1], ...windows]); // refused once, then halves
    // The head comes from the public RPC (main endpoint first, then the backup), never from the upstream.
    expect(new Set(publicReceived.map((r) => r.method))).toEqual(new Set(['eth_blockNumber']));
    expect(new Set(publicReceived.map((r) => r.endpoint))).toEqual(new Set(['main', 'backup']));
    // Every log of both contracts up to head - 3, sorted, as the upstream returned them.
    expect(await getLogs({ address: [POOL, DISPUTES], fromBlock: 'earliest' })).toEqual(logsOf([POOL, DISPUTES], 0, cachedTo));
    expect(messages()).toContain('event cache backfilled');
  });

  it('spaces upstream calls at least the spacing apart: 15 s by default, so at most 4 a minute', () => {
    const at = upstreamReceived.map((r) => r.at);
    expect(at.length).toBeGreaterThan(5);
    expectSpaced(at);
    expect(UPSTREAM_SPACING_MS).toBe(15_000);
    expect(Math.floor(60_000 / UPSTREAM_SPACING_MS)).toBeLessThanOrEqual(4);
    expect(POLL_INTERVAL_MS).toBe(20_000);
  });

  it('polls: one upstream eth_getLogs from the cache\'s next block to the new head - 3, appended in order', async () => {
    const before = upstreamReceived.length;
    const old = head - Number(FINALITY_BLOCKS);
    chainLogs.push(chainLog(POOL, 355_000, 1, [NULLIFIER, topic(10)]), chainLog(DISPUTES, 360_000, 0, [DISPUTE, topic(11), topic(12)]));
    head = 360_003;
    await until(async () => (await blockNumber()) === hex(360_000), 'the poll');
    expect(ranges(upstreamReceived.slice(before))).toEqual([[old + 1, 360_000]]);
    expect(await getLogs({ address: [DISPUTES, POOL], fromBlock: hex(349_999), toBlock: 'latest' })).toEqual(logsOf([POOL, DISPUTES], 349_999, 360_000));
    expect(messages()).toContain('event cache polled');
  });

  it('answers eth_chainId with the network and eth_blockNumber with the last cached block', async () => {
    expect(await (await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' })).json()).toEqual({ jsonrpc: '2.0', id: 1, result: '0x279f' });
    expect(await (await rpc({ jsonrpc: '2.0', id: 'b', method: 'eth_blockNumber', params: [] })).json()).toEqual({ jsonrpc: '2.0', id: 'b', result: hex(360_000) });
  });

  it('filters eth_getLogs with standard JSON-RPC semantics', async () => {
    const all = [POOL, DISPUTES];
    const pick = (keep: (l: ChainLog) => boolean): ChainLog[] => logsOf(all, 0, 360_000).filter(keep);
    const cases: [object, ChainLog[]][] = [
      [{ address: POOL.toUpperCase().replace('0X', '0x'), fromBlock: '0x0' }, logsOf([POOL], 0, 360_000)],
      [{ address: [DISPUTES], fromBlock: 'earliest', toBlock: 'latest' }, logsOf([DISPUTES], 0, 360_000)],
      [{ address: all, fromBlock: '0x0', topics: [COMMITMENT] }, pick((l) => l.topics[0] === COMMITMENT)],
      [{ address: all, fromBlock: '0x0', topics: [[COMMITMENT, NULLIFIER.toUpperCase().replace('0X', '0x')]] }, logsOf([POOL], 0, 360_000)],
      [{ address: all, fromBlock: '0x0', topics: [null, topic(3)] }, pick((l) => l.topics[1] === topic(3))],
      [{ address: all, fromBlock: '0x0', topics: [[], [topic(3), topic(11)]] }, pick((l) => l.topics[1] === topic(3) || l.topics[1] === topic(11))],
      [{ address: all, fromBlock: '0x0', topics: [[DISPUTE, null], null, null] }, pick((l) => l.topics.length >= 3)], // a log with fewer topics never matches
      [{ address: all, fromBlock: hex(51_000), toBlock: hex(151_000) }, logsOf(all, 51_000, 151_000)],
      [{ address: all }, logsOf(all, 360_000, 360_000)], // missing range = latest..latest
      [{ address: all, fromBlock: 'latest' }, logsOf(all, 360_000, 360_000)],
      [{ address: all, fromBlock: hex(355_000), toBlock: hex(9_999_999) }, logsOf(all, 355_000, 360_000)], // clamped to the cache
      [{ address: all, fromBlock: hex(360_001), toBlock: hex(9_999_999) }, []],
      [{ address: all, fromBlock: hex(200_000), toBlock: hex(100_000) }, []],
    ];
    for (const [filter, expected] of cases) expect(await getLogs(filter), JSON.stringify(filter)).toEqual(expected);
    expect(cases.map(([, expected]) => expected.length).every((n, i, a) => i >= a.length - 2 || n > 0)).toBe(true); // the cases select something
    for (const filter of [
      { address: POOL, blockHash: topic(1) },
      { address: POOL, fromBlock: 'yesterday' },
      { address: POOL, topics: [null, null, null, null, null] },
      { address: POOL, topics: ['0x12'] },
    ]) {
      expect(await call('eth_getLogs', [filter]), JSON.stringify(filter)).toMatchObject({ error: { code: -32602 } });
    }
  });

  it('refuses every other method and every other address with -32601, without asking upstream', async () => {
    const before = upstreamReceived.length;
    await expectRefusals();
    expect(upstreamReceived.length).toBe(before);
  });

  it('an upstream failure only delays the cache, which keeps answering and then catches up', async () => {
    upstreamStatus = 429;
    const before = upstreamReceived.length;
    chainLogs.push(chainLog(POOL, 365_000, 0, [COMMITMENT, topic(13)]));
    head = 370_003;
    await until(() => upstreamReceived.length >= before + 3, 'three refused upstream attempts');
    expect(await blockNumber()).toBe(hex(360_000));
    expect(await getLogs({ address: POOL, fromBlock: '0x0' })).toEqual(logsOf([POOL], 0, 360_000));
    upstreamStatus = 200;
    await until(async () => (await blockNumber()) === hex(370_000), 'the catch-up');
    expect(await getLogs({ address: POOL, fromBlock: hex(360_000) })).toEqual(logsOf([POOL], 360_000, 370_000));
    expect(ranges(upstreamReceived.slice(before)).every(([from, to]) => from === 360_001 && to <= 370_000)).toBe(true);
    const at = upstreamReceived.map((r) => r.at);
    expectSpaced(at);
  });

  it('answers malformed requests in the one error format', async () => {
    const malformed = await rpc({ method: 42 });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('allows browsers to call it', async () => {
    const res = await fetch(`${proxyUrl}/hyperrpc`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('keeps no log of its requests', async () => {
    logLines.length = 0;
    await rpc({ jsonrpc: '2.0', id: 'trace-me', method: 'eth_getLogs', params: [{ address: POOL, fromBlock: '0x0' }] });
    await rpc({ jsonrpc: '2.0', id: 'trace-me', method: 'eth_blockNumber' });
    await rpc({ jsonrpc: '2.0', id: 'trace-me', method: 'eth_call', params: [] });
    await rpc({ method: 42 });
    await new Promise((resolve) => setTimeout(resolve, 3 * POLL_MS)); // the cache polls meanwhile: no new block, no line
    expect(logLines).toEqual([]);
    await fetch(`${proxyUrl}/healthz`); // the relayer API next to it still logs its requests
    expect(logLines).toHaveLength(1);
    // The cache's own lines carry its progress only, never a URL or a request.
    head = 380_003;
    await until(async () => (await blockNumber()) === hex(380_000), 'the poll');
    expect(logLines.some((l) => l.includes('event cache polled'))).toBe(true);
    for (const line of logLines) expect(line).not.toMatch(/trace-me|mock-token-path|eth_|127\.0\.0\.1/);
  });

  it("builds Envio's HyperRPC URL for a chain", () => {
    expect(envioHyperRpcUrl(10143, 'abc')).toBe('https://10143.rpc.hypersync.xyz/abc');
  });
});

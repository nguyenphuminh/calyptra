// A local JSON-RPC proxy in front of the dev chain that records every method it is
// asked (batches included) and can misbehave on demand: be down, claim another chain, drop the
// connection of eth_getLogs or of receipt queries, refuse log ranges over `maxRange` blocks, or lag
// `lag` blocks behind the chain head.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { numberToHex } from 'viem';
import { DEVNODE_RPC } from '../../scripts/lib/devnode.ts';

export type ProxyMode = 'forward' | 'down' | 'wrong-chain' | 'fail-logs' | 'drop-receipts';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown[];
}
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}
interface LogFilter { fromBlock?: string; toBlock?: string }

export interface RpcProxy {
  url: string;
  mode: ProxyMode;
  /** eth_getLogs over more blocks than this is refused with -32005; null = no limit. */
  maxRange: number | null;
  /** The head is reported this many blocks behind, and logs after it are left out. */
  lag: number;
  /** Every method asked, in order (also while down). */
  methods: string[];
  /** [from, to] of every eth_getLogs that was answered. */
  ranges: [number, number][];
  /** Forgets the recorded methods and ranges. */
  clear(): void;
  close(): Promise<void>;
}

const servers: Server[] = [];

async function forward(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const res = await fetch(DEVNODE_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  return (await res.json()) as JsonRpcResponse;
}

async function head(): Promise<bigint> {
  const { result } = await forward({ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] });
  return BigInt(result as string);
}

export async function proxy(options: { mode?: ProxyMode; maxRange?: number; lag?: number } = {}): Promise<RpcProxy> {
  const state: RpcProxy = {
    url: '',
    mode: options.mode ?? 'forward',
    maxRange: options.maxRange ?? null,
    lag: options.lag ?? 0,
    methods: [],
    ranges: [],
    clear() {
      state.methods.length = 0;
      state.ranges.length = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  async function answer(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { id, method } = request;
    if (state.mode === 'wrong-chain' && method === 'eth_chainId') return { jsonrpc: '2.0', id, result: '0x1' };
    if (method === 'eth_blockNumber' && state.lag > 0) return { jsonrpc: '2.0', id, result: numberToHex((await head()) - BigInt(state.lag)) };
    if (method !== 'eth_getLogs') return forward(request);
    const filter = (request.params?.[0] ?? {}) as LogFilter;
    const from = Number(filter.fromBlock ?? 0);
    const to = Number(filter.toBlock ?? 0);
    if (state.maxRange !== null && to - from + 1 > state.maxRange) {
      return { jsonrpc: '2.0', id, error: { code: -32005, message: `query exceeds max block range ${state.maxRange}` } };
    }
    state.ranges.push([from, to]);
    const response = await forward(request);
    if (state.lag === 0 || !Array.isArray(response.result)) return response;
    const visible = (await head()) - BigInt(state.lag);
    return { ...response, result: (response.result as { blockNumber: string }[]).filter((log) => BigInt(log.blockNumber) <= visible) };
  }

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      void (async () => {
        let parsed: JsonRpcRequest | JsonRpcRequest[];
        try {
          parsed = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
        } catch {
          res.writeHead(400).end();
          return;
        }
        const requests = Array.isArray(parsed) ? parsed : [parsed];
        for (const r of requests) state.methods.push(r.method);
        if (state.mode === 'down') {
          res.writeHead(503).end('down');
          return;
        }
        const dropped = state.mode === 'fail-logs' ? 'eth_getLogs' : state.mode === 'drop-receipts' ? 'eth_getTransactionReceipt' : null;
        if (dropped && requests.some((r) => r.method === dropped)) {
          req.socket.destroy(); // the connection breaks without an answer
          return;
        }
        const answers = await Promise.all(requests.map(answer));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]));
      })().catch(() => res.writeHead(502).end());
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

/** Closes every proxy this file started. */
export async function closeProxies(): Promise<void> {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
}

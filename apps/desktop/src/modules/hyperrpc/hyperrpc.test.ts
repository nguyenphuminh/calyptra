import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RelayerService } from '@calyptra/framework';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRelayerApp } from '../../app.ts';
import { createHyperRpcService, envioHyperRpcUrl } from './index.ts';

const POOL = '0x1111111111111111111111111111111111111111';
const DISPUTES = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';

/** A stand-in for Envio HyperRPC that records what reaches it. */
const received: unknown[] = [];
/** Everything the relayer app logs. */
const logLines: string[] = [];
let upstreamStatus = 200;
let upstream: Server;
let upstreamUrl: string;
let proxy: Server;
let proxyUrl: string;

const body = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk: Buffer) => (text += chunk.toString()));
    req.on('end', () => resolve(text));
  });

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  expect(process.env.CALYPTRA_ENVIO_TOKEN).toBeUndefined(); // tests never use the real token
  upstream = createServer((req, res) => {
    void body(req).then((text) => {
      const request = JSON.parse(text) as { id: number; method: string };
      received.push(request);
      res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
      const result = request.method === 'eth_chainId' ? '0x279f' : request.method === 'eth_blockNumber' ? '0x10' : [{ address: POOL, data: '0x' }];
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
  });
  upstreamUrl = `${await listen(upstream)}/mock-token-path`;
  const logger = pino({ level: 'info' }, { write: (line: string) => void logLines.push(line) });
  const hyperRpc = createHyperRpcService({ upstreamUrl, contracts: [POOL, DISPUTES] });
  const relayer = {} as RelayerService; // never reached by these requests
  proxy = createServer(createRelayerApp({ relayer, logger, hyperRpc }));
  proxyUrl = await listen(proxy);
});
afterEach(() => {
  received.length = 0;
  logLines.length = 0;
  upstreamStatus = 200;
});
afterAll(() => {
  upstream.close();
  proxy.close();
});

const rpc = (payload: unknown) =>
  fetch(`${proxyUrl}/hyperrpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

describe('POST /hyperrpc', () => {
  it('forwards eth_chainId, eth_blockNumber and the logs of the pool and disputes contracts', async () => {
    expect(await (await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' })).json()).toEqual({ jsonrpc: '2.0', id: 1, result: '0x279f' });
    expect(await (await rpc({ jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] })).json()).toMatchObject({ result: '0x10' });
    const logs = { jsonrpc: '2.0', id: 3, method: 'eth_getLogs', params: [{ address: POOL.toUpperCase().replace('0X', '0x'), fromBlock: '0x1', toBlock: '0x186a0' }] };
    expect(await (await rpc(logs)).json()).toMatchObject({ id: 3, result: [{ address: POOL }] });
    await rpc({ jsonrpc: '2.0', id: 4, method: 'eth_getLogs', params: [{ address: [POOL, DISPUTES], fromBlock: '0x1', toBlock: '0x2' }] });
    expect(received).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'eth_chainId' },
      { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
      logs,
      { jsonrpc: '2.0', id: 4, method: 'eth_getLogs', params: [{ address: [POOL, DISPUTES], fromBlock: '0x1', toBlock: '0x2' }] },
    ]);
  });

  it('refuses every other method and every other address with -32601, without asking upstream', async () => {
    for (const request of [
      { jsonrpc: '2.0', id: 5, method: 'eth_sendRawTransaction', params: ['0x00'] },
      { jsonrpc: '2.0', id: 6, method: 'eth_call', params: [{ to: POOL, data: '0x' }, 'latest'] },
      { jsonrpc: '2.0', id: 7, method: 'eth_getLogs', params: [{ address: OTHER, fromBlock: '0x1', toBlock: '0x2' }] },
      { jsonrpc: '2.0', id: 8, method: 'eth_getLogs', params: [{ address: [POOL, OTHER] }] },
      { jsonrpc: '2.0', id: 9, method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x2', topics: [] }] },
      { jsonrpc: '2.0', id: 10, method: 'eth_getLogs', params: [] },
    ]) {
      const res = await rpc(request);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: request.id, error: { code: -32601 } });
    }
    expect(received).toEqual([]);
  });

  it('answers malformed requests and upstream failures in the one error format', async () => {
    const malformed = await rpc({ method: 42 });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: 'INVALID_INPUT' });
    upstreamStatus = 500;
    const failed = await rpc({ jsonrpc: '2.0', id: 11, method: 'eth_chainId' });
    expect(failed.status).toBe(502);
    const error = await failed.json();
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(JSON.stringify(error)).not.toContain('mock-token-path'); // the upstream URL holds the token
  });

  it('allows browsers to call it', async () => {
    const res = await fetch(`${proxyUrl}/hyperrpc`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('keeps no log of its requests', async () => {
    await rpc({ jsonrpc: '2.0', id: 12, method: 'eth_getLogs', params: [{ address: POOL }] });
    await rpc({ jsonrpc: '2.0', id: 13, method: 'eth_call', params: [] });
    expect(logLines).toEqual([]);
    await fetch(`${proxyUrl}/healthz`); // the relayer API next to it still logs its requests
    expect(logLines).toHaveLength(1);
  });

  it("builds Envio's HyperRPC URL for a chain", () => {
    expect(envioHyperRpcUrl(10143, 'abc')).toBe('https://10143.rpc.hypersync.xyz/abc');
  });
});

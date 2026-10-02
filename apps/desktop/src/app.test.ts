import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Calyptra, ChainAdapter, DEFAULT_NETWORK, MemoryStore, RelayerService } from '@calyptra/framework';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { Express, Request, Response } from 'express';
import { zeroAddress } from 'viem';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRelayerApp, createRpcApp } from './app.ts';
import { NodeService } from './modules/node/index.ts';
import { createLogger } from './shared/logger.ts';
import { localOnly } from './shared/middlewares/index.ts';

const logger = createLogger('silent');
const servers: Server[] = [];

async function serve(app: Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** An offline facade: memory storage, no proofs, no libp2p, no relayers. */
async function offlineCalyptra(): Promise<Calyptra> {
  const calyptra = new Calyptra({
    store: new MemoryStore(),
    artifacts: async () => ({ wasm: '', zkey: '' }),
    createNode: () => Promise.reject(new Error('offline')),
    kdf: { N: 2 ** 10, r: 8, p: 1 },
    relayers: [],
    libp2pRelays: [],
  });
  await calyptra.wallet.createFromPhrase(generateMnemonic(wordlist, 128), 'password123');
  await calyptra.start();
  return calyptra;
}

let calyptra: Calyptra;
beforeAll(async () => {
  calyptra = await offlineCalyptra();
});
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  await calyptra.lock();
});

describe('local RPC server', () => {
  const token = randomBytes(32).toString('hex');
  let ready = true;
  let url: string;
  const call = (command: string, body: unknown, auth = `Bearer ${token}`) =>
    fetch(`${url}/rpc/${command}`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    const node = new NodeService(calyptra, { roles: () => ({ relayer: null, libp2pRelay: null }) });
    url = await serve(createRpcApp({ node, token, logger, ready: () => ready }));
  });

  it('rejects calls without the right token', async () => {
    const unauthorized = { code: 'UNAUTHORIZED', message: 'Missing or wrong access token' };
    for (const auth of ['', `Bearer ${randomBytes(32).toString('hex')}`, 'Bearer abc']) {
      const res = await call('accounts', {}, auth);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(unauthorized);
    }
    const unknownPath = await fetch(`${url}/nowhere`);
    expect(unknownPath.status).toBe(401);
  });

  it('runs commands with the token', async () => {
    expect(await (await call('accounts', {})).json()).toEqual([expect.objectContaining({ label: 'Account 1', active: true, relayer: false })]);
    expect(await (await call('account.add', {})).json()).toMatchObject({ label: 'Account 2', active: false, kind: 'derived', used: false });
    expect(await (await call('status', {})).json()).toMatchObject({
      account: { label: 'Account 1', active: true },
      network: { id: DEFAULT_NETWORK },
      shieldedAddress: expect.stringMatching(/^cal[0-9a-f]{136}$/),
      shieldedBalance: { native: '0 MON', stablecoin: '0 AUSD' },
      lastExportAt: null,
      roles: { relayer: null, libp2pRelay: null },
    });
  });

  it('answers every error in one format', async () => {
    const unknown = await call('frobnicate', {});
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ code: 'UNKNOWN_COMMAND', message: 'Unknown command "frobnicate"' });
    const invalid = await call('deposit', { token: 'doge', amount: 'lots' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'INVALID_INPUT' });
    const malformed = await fetch(`${url}/rpc/accounts`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"nope' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ code: 'INVALID_JSON', message: 'The request body is not valid JSON' });
    const missing = await fetch(`${url}/nowhere`, { headers: { authorization: `Bearer ${token}` } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: 'NOT_FOUND', message: 'No such endpoint' });
  });

  it('answers /healthz without a token, 503 while not ready', async () => {
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    ready = false;
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
    ready = true;
  });

  it('accepts only local connections', () => {
    const res = {} as Response;
    const from = (remoteAddress: string) => ({ socket: { remoteAddress } }) as Request;
    expect(() => localOnly()(from('192.168.1.20'), res, vi.fn())).toThrow('only accepts local connections');
    const next = vi.fn();
    localOnly()(from('::1'), res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('public relayer server', () => {
  let url: string;

  beforeAll(async () => {
    const network = calyptra.network();
    const relayer = new RelayerService(new ChainAdapter(network), {
      account: calyptra.wallet.signer(),
      keys: await calyptra.keys.poolKeys(),
      fees: { [zeroAddress]: 100n },
    });
    url = await serve(createRelayerApp({ relayer, logger }));
  });

  it('answers CORS preflights', async () => {
    const res = await fetch(`${url}/relayer/submit`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
  });

  it('quotes its fees and refuses malformed requests before touching the chain', async () => {
    expect(await (await fetch(`${url}/relayer/info`)).json()).toMatchObject({
      fees: { [zeroAddress]: '100' },
      shieldedAddress: expect.stringMatching(/^cal[0-9a-f]{136}$/),
    });
    const res = await fetch(`${url}/relayer/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'transact' }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT' });
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/hyperrpc`, { method: 'POST' })).status).toBe(404); // the proxy is off without a token
  });
});

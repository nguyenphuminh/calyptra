// The user's own RPC endpoints (UI-W9), in Settings › Advanced: checked before they are
// kept, tried first, and with the network's own switched off nobody else is asked.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEVNODE_RPC } from '../../scripts/lib/devnode.ts';
import { card, devNetworkInfo, devWallet, expect, openSettings, openWallet, test, unlock } from './helpers.ts';

type Mode = 'forward' | 'down' | 'wrong-chain';
interface Proxy { url: string; requests: number; mode: Mode; close(): Promise<void> }

const bodyOf = async (req: IncomingMessage): Promise<string> => {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return body;
};

/** A browser-facing JSON-RPC proxy in front of the dev chain at <url>/rpc: CORS open, counts requests, can go down or claim chain 1. */
async function rpcProxy(): Promise<Proxy> {
  const proxy = { url: '', requests: 0, mode: 'forward' as Mode, close: async () => undefined };
  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    proxy.requests++;
    void (async () => {
      const body = await bodyOf(req);
      if (proxy.mode === 'down') {
        res.writeHead(503).end('down');
        return;
      }
      if (proxy.mode === 'wrong-chain') {
        const call = JSON.parse(body) as { id: number; method: string } | { id: number; method: string }[];
        const calls = Array.isArray(call) ? call : [call];
        if (calls.every((c) => c.method === 'eth_chainId')) {
          const answers = calls.map((c) => ({ jsonrpc: '2.0', id: c.id, result: '0x1' }));
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(call) ? answers : answers[0]));
          return;
        }
      }
      const upstream = await fetch(DEVNODE_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(await upstream.text());
    })().catch(() => res.writeHead(502).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`;
  proxy.close = () => new Promise<undefined>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve(undefined));
  });
  return proxy;
}

test('UI-W9: own RPC endpoints are checked, tried first, and with the fallback off the network’s are never asked', async ({ newUser }) => {
  const dev = devNetworkInfo();
  const own = await rpcProxy();
  const wrong = await rpcProxy();
  wrong.mode = 'wrong-chain';
  try {
    const page = await devWallet(newUser, 'w9', '0.1');
    await openSettings(page, 'Advanced');
    const rpc = card(page, `RPC endpoints on ${dev.name}`);
    const add = async (url: string): Promise<void> => {
      await rpc.getByLabel('Add your own').fill(url);
      await rpc.getByRole('button', { name: 'Add', exact: true }).click();
    };
    await add('http://127.0.0.1:9/rpc');
    await expect(rpc.getByRole('alert')).toHaveText('This RPC endpoint does not answer');
    await add(wrong.url);
    await expect(rpc.getByRole('alert')).toHaveText(`This endpoint serves chain 1, not ${dev.name} (${dev.chainId})`);
    await add(own.url);
    const ownItem = rpc.getByRole('listitem').filter({ hasText: own.url });
    await expect(ownItem.getByRole('button', { name: 'Remove' })).toBeVisible();
    const fallback = rpc.getByLabel('Use the network’s endpoints when mine do not answer');
    await expect(fallback).toBeChecked();
    await fallback.uncheck();
    await expect(rpc.getByRole('listitem').filter({ hasText: dev.rpcUrl })).toContainText('Not used');
    await expect.poll(() => own.requests).toBeGreaterThan(0);

    await sleep(2_000); // the node has restarted on the new endpoints
    const networkOrigin = new URL(dev.rpcUrl).origin;
    const toNetwork: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).origin === networkOrigin) toNetwork.push(request.url());
    });
    await openWallet(page);
    const hero = card(page, 'Private balance');
    await hero.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByTestId('shielded-native')).toHaveText('0.1 MON');
    own.mode = 'down';
    await hero.getByRole('button', { name: 'Refresh' }).click();
    await expect(hero.getByRole('alert')).toContainText('Calyptra cannot reach the network right now');
    await expect(card(page, 'Account balance').getByRole('alert')).toContainText('Calyptra cannot reach the network right now');
    expect(toNetwork).toEqual([]);

    await openSettings(page, 'Advanced');
    await fallback.check();
    await openWallet(page);
    await hero.getByRole('button', { name: 'Refresh' }).click();
    await expect(hero.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    await expect(hero.getByRole('alert')).toHaveCount(0);
    await expect.poll(() => toNetwork.length).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Lock' }).click();
    await unlock(page);
    await openSettings(page, 'Advanced');
    await expect(ownItem).toBeVisible();
    await ownItem.getByRole('button', { name: 'Remove' }).click();
    await expect(rpc.getByText(own.url)).toHaveCount(0);
    await expect(fallback).toHaveCount(0); // shown only with endpoints of one's own
  } finally {
    await own.close();
    await wrong.close();
  }
});

import type { Calyptra } from '@calyptra/framework';
import { describe, expect, it } from 'vitest';
import { readSettings, writeSettings, type WebSettings } from './settings.ts';

/** A wallet's settings section and a node that cannot start with a message relay address it cannot read. */
function node() {
  const sections = new Map<string, unknown>();
  let relays: string[] = [];
  let starts = 0;
  const calyptra = {
    wallet: {
      readSection: (name: string) => sections.get(name) ?? null,
      writeSection: async (name: string, value: unknown) => { sections.set(name, value); },
    },
    network: () => ({ relayers: [], libp2pRelays: ['/dns4/relay.example/tcp/443/wss/p2p/12D3KooWNetwork'] }),
    configure: (changes: { libp2pRelays: string[] }) => { relays = changes.libp2pRelays; },
    start: async () => {
      if (relays.some((r) => !r.startsWith('/'))) throw new Error('String multiaddr must start with "/"');
      starts++;
    },
  };
  return { calyptra: calyptra as unknown as Calyptra, relays: () => relays, starts: () => starts };
}

describe('writeSettings', () => {
  it('keeps the previous settings, and the node running with them, when the node cannot start with the new ones', async () => {
    const n = node();
    const good: WebSettings = { relayers: [], libp2pRelays: ['/dns4/mine.example/tcp/443/wss/p2p/12D3KooWMine'], rpcUrls: [], rpcFallback: true };
    await writeSettings(n.calyptra, good);
    await expect(writeSettings(n.calyptra, { ...good, libp2pRelays: ['garbage', ...good.libp2pRelays] }))
      .rejects.toThrow('Calyptra could not start with this setting, so it was not saved.');
    expect(readSettings(n.calyptra)).toEqual(good);
    expect(n.relays()).toEqual([...good.libp2pRelays, '/dns4/relay.example/tcp/443/wss/p2p/12D3KooWNetwork']);
    expect(n.starts()).toBe(2);
  });
});

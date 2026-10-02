import { createServer } from 'node:net';
import type { Libp2p } from '@libp2p/interface';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPeerNode, createRelayNode } from '../../libp2p.node.ts';
import { AppError } from '../../shared/errors/AppError.ts';
import { decodeInvite, encodeInvite, inviteLink, type Invite } from './invite.ts';
import { P2PService } from './p2p.service.ts';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });

const nodes: Libp2p[] = [];
async function relay(announce?: string[]): Promise<{ node: Libp2p; addr: string }> {
  const port = await freePort();
  const node = await createRelayNode({ listen: [`/ip4/127.0.0.1/tcp/${port}/ws`], announce });
  nodes.push(node);
  return { node, addr: `/ip4/127.0.0.1/tcp/${port}/ws/p2p/${node.peerId.toString()}` };
}
async function peer(relayAddr: string, timeoutMs?: number): Promise<P2PService> {
  const node = await createPeerNode({ relays: [relayAddr] });
  nodes.push(node);
  const p2p = new P2PService(node, timeoutMs === undefined ? {} : { timeoutMs });
  await p2p.waitForRelay();
  return p2p;
}

afterAll(async () => {
  await Promise.all(nodes.map(async (n) => {
    try {
      await n.stop();
    } catch {
      // already stopped
    }
  }));
});

describe('invites', () => {
  const invite: Invite = { v: 1, peerId: '12D3KooWpeer', addrs: ['/ip4/1.2.3.4/tcp/1/ws/p2p/12D3KooWrelay/p2p-circuit/p2p/12D3KooWpeer'], shieldedAddress: 'cal00' };
  it('round-trip as a code and as a link', () => {
    expect(decodeInvite(encodeInvite(invite))).toEqual(invite);
    const link = inviteLink('https://example.org/', invite);
    expect(link.startsWith('https://example.org/#/invite/')).toBe(true);
    expect(decodeInvite(link)).toEqual(invite);
  });
  it('refuse garbage and direct addresses', () => {
    expect(() => decodeInvite('garbage')).toThrow('This is not a valid Calyptra invite');
    expect(() => encodeInvite({ ...invite, addrs: ['/ip4/1.2.3.4/tcp/1'] })).toThrow();
    expect(() => encodeInvite({ ...invite, addrs: [] })).toThrow();
  });
});

describe('P2PService through a relay', () => {
  let relayAddr: string;
  let alice: P2PService;
  let bob: P2PService;
  const seen: { from: string; message: unknown }[] = [];

  beforeAll(async () => {
    relayAddr = (await relay()).addr;
    alice = await peer(relayAddr);
    bob = await peer(relayAddr);
    await bob.listen(async (from, message) => {
      seen.push({ from, message });
      const m = message as { refuse?: boolean };
      if (m.refuse) throw new AppError(403, 'NOPE', 'Bob refuses');
      return { echo: message, big: 12345678901234567890n };
    });
  }, 30_000);

  it('invites carry only relay circuit addresses', () => {
    const invite = bob.invite('cal00');
    expect(invite.addrs.length).toBeGreaterThan(0);
    for (const a of invite.addrs) expect(a).toContain('/p2p-circuit/p2p/');
    expect(decodeInvite(encodeInvite(invite))).toEqual(invite);
  });

  it('returns the answer; the handler sees the authenticated sender; bigints arrive as decimal strings', async () => {
    const reply = await alice.request(bob.invite('cal00'), { n: 7n });
    expect(reply).toEqual({ echo: { n: '7' }, big: '12345678901234567890' });
    expect(seen.at(-1)).toEqual({ from: alice.peerId, message: { n: '7' } });
  });

  it('returns refusals as errors with the handler’s code and message', async () => {
    await expect(alice.request(bob.invite('cal00'), { refuse: true })).rejects.toMatchObject({ code: 'NOPE', message: 'Bob refuses', statusCode: 409 });
  });

  it('carries long-lived sessions with several messages both ways', async () => {
    await bob.handleSessions('/calyptra/test-session/1.0.0', async (session) => {
      for await (const m of session.messages()) {
        await session.send({ got: m, from: session.peerId });
        await session.send({ again: true });
      }
    });
    const session = await alice.openSession(bob.invite('cal00'), '/calyptra/test-session/1.0.0');
    const received: unknown[] = [];
    const reading = (async () => {
      for await (const m of session.messages()) {
        received.push(m);
        if (received.length === 4) break;
      }
    })();
    await session.send({ n: 1n });
    await session.send({ n: 2n });
    await reading;
    await session.close();
    expect(received).toEqual([{ got: { n: '1' }, from: alice.peerId }, { again: true }, { got: { n: '2' }, from: alice.peerId }, { again: true }]);
  });

  it('keeps relayed connections through the ping health checks', async () => {
    await alice.request(bob.invite('cal00'), { first: true });
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    await expect(alice.request(bob.invite('cal00'), { second: true })).resolves.toMatchObject({ echo: { second: true } });
  }, 30_000);
});

describe('P2PService failures', () => {
  it('times out on a silent peer and fails on an unknown one', async () => {
    const { addr } = await relay();
    const asker = await peer(addr, 1_500);
    const silent = await peer(addr);
    await silent.listen(() => new Promise(() => undefined));
    await expect(asker.request(silent.invite('cal00'), { hello: true })).rejects.toMatchObject({
      code: 'PEER_TIMEOUT', message: 'The other party did not answer in time',
    });
    const gone = await peer(addr);
    const target = gone.invite('cal00');
    await gone.stop();
    await expect(asker.request(target, { hello: true })).rejects.toMatchObject({ code: 'PEER_UNREACHABLE' });
  }, 30_000);

  it('hands out the relay’s announced address', async () => {
    const { node, addr } = await relay(['/dns4/relay.example/tcp/443/wss']);
    const p = await peer(addr);
    const invite = p.invite('cal00');
    expect(invite.addrs.some((a) => a.startsWith(`/dns4/relay.example/tcp/443/wss/p2p/${node.peerId.toString()}/p2p-circuit/p2p/`))).toBe(true);
  }, 30_000);
});

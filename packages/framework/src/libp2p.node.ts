import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { identify } from '@libp2p/identify';
import type { Libp2p } from '@libp2p/interface';
import { ping } from '@libp2p/ping';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { createLibp2p } from 'libp2p';

/** Relayed connections carry whole channel sessions, so the relay lifts the default 2-minute/128 KB limits. */
const RELAY_LIMITS = { applyDefaultLimit: false, maxReservations: 1024 };

/** The desktop client's libp2p relay mode: reachable over WebSockets (for web wallets) and TCP. It forwards
 *  encrypted connections and records nothing about who talks to whom. `announce` replaces the listen addresses
 *  in what the relay tells peers (e.g. its public /dns4/<host>/tcp/443/wss address behind a TLS proxy). */
export async function createRelayNode(options: { listen: string[]; announce?: string[]; seed?: Uint8Array }): Promise<Libp2p> {
  return createLibp2p({
    ...(options.seed ? { privateKey: await generateKeyPairFromSeed('Ed25519', options.seed) } : {}),
    addresses: { listen: options.listen, ...(options.announce?.length ? { announce: options.announce } : {}) },
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), ping: ping(), relay: circuitRelayServer({ reservations: RELAY_LIMITS }) },
  });
}

/** A user's node in Node.js: reachable only through the given relays (it listens on relay circuits, so its own
 *  IP never appears in an invite). `seed` keeps the same peer ID across restarts. */
export async function createPeerNode(options: { relays: string[]; seed?: Uint8Array }): Promise<Libp2p> {
  return createLibp2p({
    ...(options.seed ? { privateKey: await generateKeyPairFromSeed('Ed25519', options.seed) } : {}),
    addresses: { listen: options.relays.map((r) => `${r}/p2p-circuit`) },
    transports: [tcp(), webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), ping: ping() },
  });
}

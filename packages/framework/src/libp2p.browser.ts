import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { identify } from '@libp2p/identify';
import { FaultTolerance, type Libp2p } from '@libp2p/interface';
import { ping } from '@libp2p/ping';
import { webSockets } from '@libp2p/websockets';
import { createLibp2p } from 'libp2p';

/** Browsers reach peers only through relays, over WebSockets, and stay on relayed connections so no party
 *  learns another's IP address. */
export async function createBrowserNode(options: { relays: string[]; seed?: Uint8Array }): Promise<Libp2p> {
  return createLibp2p({
    ...(options.seed ? { privateKey: await generateKeyPairFromSeed('Ed25519', options.seed) } : {}),
    addresses: { listen: options.relays.map((r) => `${r}/p2p-circuit`) },
    // An unreachable relay must not stop the node from starting (the wallet would not unlock):
    // P2PService.restoreRelays() makes the reservation once the relay answers again.
    transportManager: { faultTolerance: FaultTolerance.NO_FATAL },
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), ping: ping() },
    // Allow relays on local or LAN addresses (e.g. a desktop client relaying on the same machine), which libp2p
    // refuses to dial by default. Peers stay relayed: this node has no transport that could listen directly.
    connectionGater: { denyDialMultiaddr: () => false },
  });
}
